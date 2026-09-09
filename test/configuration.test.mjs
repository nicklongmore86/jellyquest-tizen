import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

test('postinstall skips a missing Jellyfin Web build with actionable instructions', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jellyquest-install-'));
    try {
        const result = spawnSync(process.execPath, [path.join(root, 'scripts/postinstall.mjs')], {
            cwd: directory,
            encoding: 'utf8',
            env: { ...process.env, JELLYFIN_WEB_DIR: '', npm_execpath: path.join(directory, 'missing-npm.mjs') }
        });
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /Skipping the jellyfin-web-dependent build/);
        assert.match(result.stdout, /npm run build:full/);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('postinstall reports actionable instructions when invoked without npm', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jellyquest-install-'));
    try {
        const env = { ...process.env, JELLYFIN_WEB_DIR: directory };
        delete env.npm_execpath;
        const result = spawnSync(process.execPath, [path.join(root, 'scripts/postinstall.mjs')], {
            cwd: directory,
            encoding: 'utf8',
            env
        });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /npm_execpath is unset/);
        assert.match(result.stderr, /Run npm run postinstall/);
        assert.doesNotMatch(result.stderr, /MODULE_NOT_FOUND/);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('postinstall delegates to npm run build and preserves failures for default and overridden Web paths', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jellyquest-install-'));
    try {
        const npmPath = path.join(directory, 'npm.mjs');
        fs.writeFileSync(npmPath, `import assert from 'node:assert/strict';
assert.deepEqual(process.argv.slice(2), ['run', 'build']);
console.log('fixture build invoked');
process.exitCode = Number(process.env.FIXTURE_BUILD_STATUS);
`);
        for (const webPath of ['', 'custom-web/dist', path.join(directory, 'absolute-web/dist')]) {
            const dist = path.resolve(directory, webPath || 'node_modules/jellyfin-web/dist');
            fs.mkdirSync(dist, { recursive: true });
            for (const status of [0, 7]) {
                const result = spawnSync(process.execPath, [path.join(root, 'scripts/postinstall.mjs')], {
                    cwd: directory,
                    encoding: 'utf8',
                    env: { ...process.env, JELLYFIN_WEB_DIR: webPath, npm_execpath: npmPath, FIXTURE_BUILD_STATUS: String(status) }
                });
                assert.equal(result.status, status, result.stderr);
                assert.match(result.stdout, /fixture build invoked/);
                assert.doesNotMatch(result.stdout, /Skipping/);
            }
            fs.rmSync(dist, { recursive: true });
        }
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('shipped bundle excludes the on-screen keydown diagnostics panel', () => {
    const bundle = fs.readFileSync(path.join(root, 'jellyquest.js'), 'utf8');
    assert.doesNotMatch(bundle, /jq-keydown-diagnostics/);
});

test('committed jellyquest.js/jellyquest.css match what src/overlay/* currently generates', () => {
    // jellyquest.js/jellyquest.css are generated (see scripts/build-overlay.mjs)
    // but committed directly, since gulpfile.babel.js/package-wgt.sh expect
    // them to already exist at the project root at packaging time. This
    // regenerates them for real and fails if that produced any diff --
    // catching the case where src/overlay/* was edited without re-running
    // `npm run build:overlay` before committing.
    const before = {
        js: fs.readFileSync(path.join(root, 'jellyquest.js'), 'utf8'),
        css: fs.readFileSync(path.join(root, 'jellyquest.css'), 'utf8'),
    };
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/build-overlay.mjs')], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const after = {
        js: fs.readFileSync(path.join(root, 'jellyquest.js'), 'utf8'),
        css: fs.readFileSync(path.join(root, 'jellyquest.css'), 'utf8'),
    };
    assert.equal(after.js, before.js, 'jellyquest.js is stale -- run `npm run build:overlay` and commit the result');
    assert.equal(after.css, before.css, 'jellyquest.css is stale -- run `npm run build:overlay` and commit the result');
});

test('locks generated Jellyfin Web configuration to Farmhouse', () => {
    const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'jellyquest-tizen-'));
    fs.writeFileSync(path.join(outputDirectory, 'config.json'), JSON.stringify({ multiserver: true, servers: [], plugins: [] }));

    const result = spawnSync(process.execPath, [path.join(root, 'scripts/configure-jellyquest.mjs')], {
        encoding: 'utf8',
        env: { ...process.env, JELLYFIN_TIZEN_WWW_DIR: outputDirectory }
    });

    assert.equal(result.status, 0, result.stderr);
    const config = JSON.parse(fs.readFileSync(path.join(outputDirectory, 'config.json'), 'utf8'));
    assert.equal(config.multiserver, false);
    assert.deepEqual(config.servers, ['https://jelly-farmhouse.starrgroup.io']);
    assert.deepEqual(config.menuLinks, [{
        name: 'Requests',
        icon: 'add_circle',
        url: 'https://jellyseerr.starrgroup.io'
    }]);
    const metadata = JSON.parse(fs.readFileSync(path.join(outputDirectory, 'jellyquest-build.json'), 'utf8'));
    assert.equal(metadata.household, 'farmhouse');
    assert.equal(metadata.requestsUrl, 'https://jellyseerr.starrgroup.io');
    assert.equal(metadata.requestsBridgeUrl, 'https://jelly-farmhouse.starrgroup.io/jellyquest-bridge/bridge.html');
    const appVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
    assert.equal(metadata.requestsPageVersion, appVersion);
    // config.xml is the ONE file scripts/install-wgt.sh:10 reads to learn which
    // version the TV registry must report back after an install; a bump that
    // misses it leaves that check asserting a stale version, which passes even
    // when the new build never landed. Parsed by handing config.xml to that
    // script's own sed program verbatim, so this test cannot accept a manifest
    // the installer would read differently.
    const manifestVersion = spawnSync('sed', ['-n', 's/.*<widget[^>]*version="\\([^"]*\\)".*/\\1/p', path.join(root, 'config.xml')], { encoding: 'utf8' });
    assert.equal(manifestVersion.stdout.trim(), appVersion);
    assert.match(metadata.jellyfinWebRef, /^[a-f0-9]{40}$/);
});

test('overlay injection points still target the app-owned files', () => {
    // jellyquest.css/jellyquest.js content is being rebuilt from scratch (see the
    // blank-canvas rebuild plan); this test only pins the injection contract that
    // gulpfile.babel.js and tizen.js must keep honoring, not the overlay's content.
    const gulpfile = fs.readFileSync(path.join(root, 'gulpfile.babel.js'), 'utf8');
    const adapter = fs.readFileSync(path.join(root, 'tizen.js'), 'utf8');
    const manifest = fs.readFileSync(path.join(root, 'config.xml'), 'utf8');

    assert.match(gulpfile, /\.\.\/jellyquest\.css/);
    assert.match(gulpfile, /\.\.\/jellyquest\.js/);
    assert.match(gulpfile, /data: blob: gap:/);
    assert.match(adapter, /JellyQuest for Tizen/);
    assert.doesNotMatch(adapter, /'multiserver'/);
    assert.match(manifest, /id="JellyQuest\.JellyQuest"/);
    assert.match(manifest, /package="JellyQuest"/);
    assert.doesNotMatch(manifest, /AprZAARz4r\.Jellyfin/);
});

// scripts/package-wgt.sh hands `tizen build-web` a list of exclusion globs.
// Reading those globs back as patterns -- rather than regex-matching the script's
// own text -- lets the keep-side test below check runtime paths against every
// parsed exclusion, including spellings nobody thought to pin literally. It
// checks the representative paths listed there, not every file that ships, and
// only the shell syntax the lexer below models (see that test for the limits).

// Which characters are syntactically ACTIVE depends on the quoting context they
// appear in, so the two sets below are applied per context, never to a word's raw
// text. Unquoted, all of these do something. Inside double quotes only expansion
// and escaping survive -- `;`, `&`, `|`, `<`, `>` and parens are already literal
// there. Inside SINGLE quotes bash makes everything literal, so nothing is active
// and nothing is refused.
const ACTIVE_UNQUOTED = /[\\$`;&|<>()]/;
const ACTIVE_IN_DOUBLE_QUOTES = /[\\$`]/g;

// Enough shell lexing to read one command's words: quotes, backslash-newline
// continuations between words, and comments. Comments matter because a
// `# -e foo` note near the command otherwise reads as a real exclusion.
//
// Alongside the value, each word collects the active characters it passed
// through. An exclusion whose value went through none can be trusted to be the
// literal string bash would hand tizen; one that did not is refused rather than
// guessed at, because this lexer does not expand or escape anything.
function shellWords(command) {
    const words = [];
    let current = null;
    let active = '';
    let index = 0;

    const flush = () => {
        if (current === null) return;
        words.push({ value: current, active });
        current = null;
        active = '';
    };

    while (index < command.length) {
        const character = command[index];

        if (current === null && character === '\\' && command[index + 1] === '\n') {
            index += 2;
        } else if (current === null && character === '#') {
            const lineEnd = command.indexOf('\n', index);
            index = lineEnd === -1 ? command.length : lineEnd;
        } else if (/\s/.test(character)) {
            flush();
            index += 1;
        } else if (character === '"' || character === '\'') {
            const close = command.indexOf(character, index + 1);
            assert.notEqual(close, -1, `unterminated ${character} quote in the tizen build-web command`);
            const contents = command.slice(index + 1, close);
            if (character === '"') active += contents.match(ACTIVE_IN_DOUBLE_QUOTES)?.join('') ?? '';
            current = (current ?? '') + contents;
            index = close + 1;
        } else {
            if (ACTIVE_UNQUOTED.test(character)) active += character;
            current = (current ?? '') + character;
            index += 1;
        }
    }

    flush();

    return words;
}

function packagerExclusions(packager) {
    const [command] = packager.match(/tizen build-web[\s\S]*?(?=\ntizen package)/) ?? [];
    assert.ok(command, 'scripts/package-wgt.sh no longer invokes tizen build-web');

    const words = shellWords(command);
    const exclusions = [];

    // A parser that silently mis-reads an exclusion is worse than one that
    // refuses: a value this lexer cannot model means the test compares the wrong
    // string while still reporting green. Fail loudly instead.
    const take = (flag, word) => {
        assert.ok(
            word !== undefined && word.value !== '' && !word.value.startsWith('-'),
            `malformed exclusion after ${flag} in scripts/package-wgt.sh: `
                + (word === undefined ? '(end of command)' : JSON.stringify(word.value))
        );
        assert.equal(
            word.active,
            '',
            `unmodelled shell syntax ${JSON.stringify(word.active)} in the exclusion after ${flag}`
                + ` in scripts/package-wgt.sh: ${JSON.stringify(word.value)}`
        );

        return word.value;
    };

    for (let index = 0; index < words.length; index += 1) {
        const { value, active } = words[index];
        // Tizen documents --exclude as the long form of -e, so both are read here;
        // treating --exclude as an ordinary argument would silently hide it.
        const inline = /^(?:-e|--exclude)=(.*)$/.exec(value);

        if (inline) {
            assert.notEqual(inline[1], '', `empty exclusion value in scripts/package-wgt.sh: ${value}`);
            exclusions.push(take(value.split('=')[0], { value: inline[1], active }));
            continue;
        }

        if (value !== '-e' && value !== '--exclude') continue;

        exclusions.push(take(value, words[index + 1]));
        index += 1;
    }

    return exclusions;
}

// Tizen reads an exclusion as a path glob relative to the project root, where
// `dir/*` drops the whole subtree. `*` is widened to "any characters" so that a
// broad pattern counts as excluding a path instead of slipping past the check.
//
// ONLY `*` is modelled. The available Tizen documentation does not establish the
// rest of the wildcard grammar -- `?`, bracket expressions, and whatever default
// exclusions the tool applies on its own are all unverified, so they are left
// unimplemented rather than guessed at.
function excludesPath(pattern, filePath) {
    const source = pattern
        .split('*')
        .map((literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*');

    return new RegExp(`^${source}(?:/.*)?$`).test(filePath);
}

test('parses the packager exclusion flags without silently mis-reading them', () => {
    const command = (body) => `tizen build-web ${body}\ntizen package -t wgt -o out -- .buildResult\n`;

    assert.deepEqual(packagerExclusions(command('-e "a/*" -e b.md')), ['a/*', 'b.md']);
    // --exclude is the documented long form; reading it as a plain argument would
    // let `--exclude jellyquest.js` drop a required file with the tests still green.
    assert.deepEqual(packagerExclusions(command('--exclude "a/*" --exclude=b.md')), ['a/*', 'b.md']);
    // A backslash-newline is a line continuation, not the exclusion's value.
    assert.deepEqual(packagerExclusions(command('-e \\\n  jellyquest.js')), ['jellyquest.js']);
    // A comment is not an exclusion, and must not read as one.
    assert.deepEqual(packagerExclusions(command('-e a.md\n# -e jellyquest.js')), ['a.md']);
    assert.deepEqual(packagerExclusions(command('-e a.md # -e jellyquest.js')), ['a.md']);

    // A quoted value may contain spaces; that much is modelled.
    assert.deepEqual(packagerExclusions(command('-e "some dir/*"')), ['some dir/*']);

    // ACCEPTED: characters that are inert where they appear. Refusing these would
    // fail the suite on a perfectly valid script, which is worse than the false
    // acceptance the refusals were added to stop -- a maintainer excluding a path
    // with parens, a literal $ or a ; would be told their script is malformed.
    // Single quotes make everything literal, so nothing in them is refused.
    assert.deepEqual(packagerExclusions(command('-e \'docs/notes (old)/*\'')), ['docs/notes (old)/*']);
    assert.deepEqual(packagerExclusions(command('-e \'docs/$notes.md\'')), ['docs/$notes.md']);
    assert.deepEqual(packagerExclusions(command('-e \'docs/a;b`c\\d/*\'')), ['docs/a;b`c\\d/*']);
    // Inside double quotes `;`, `&`, `|`, `<`, `>` and parens are already literal.
    assert.deepEqual(packagerExclusions(command('-e "docs/notes;old/*"')), ['docs/notes;old/*']);
    assert.deepEqual(packagerExclusions(command('-e "docs/notes (old)|x&y/*"')), ['docs/notes (old)|x&y/*']);
    // Glob characters are never refused: modelling them is out of scope, not unsafe.
    assert.deepEqual(packagerExclusions(command('-e "docs/?/*" -e "docs/[ab]/*"')), ['docs/?/*', 'docs/[ab]/*']);

    // Missing or malformed values fail loudly rather than being guessed at.
    assert.throws(() => packagerExclusions(command('-e')), /malformed exclusion after -e/);
    assert.throws(() => packagerExclusions(command('-e -t wgt')), /malformed exclusion after -e/);
    assert.throws(() => packagerExclusions(command('--exclude= -e a.md')), /empty exclusion value/);
    assert.throws(() => packagerExclusions(command('-e "unterminated')), /unterminated " quote/);
    assert.throws(() => packagerExclusions('tizen package -t wgt\n'), /no longer invokes tizen build-web/);

    // Refused: syntax that is ACTIVE where it appears, so bash would pass a
    // different string than the one lexed here. Each of these excludes
    // www/config.json in bash while a naive lexer reads some other literal.
    assert.throws(() => packagerExclusions(command('-e www/\\config.json')), /unmodelled shell syntax/);
    assert.throws(() => packagerExclusions(command('-e "www/confi\\\ng.json"')), /unmodelled shell syntax/);
    assert.throws(() => packagerExclusions(command('-e "$DROP"')), /unmodelled shell syntax/);
    assert.throws(() => packagerExclusions(command('-e www/config.json;')), /unmodelled shell syntax/);
    assert.throws(() => packagerExclusions(command('-e `printf x`')), /unmodelled shell syntax/);
    assert.throws(() => packagerExclusions(command('--exclude=www/config.json;')), /unmodelled shell syntax/);
    // The same character refused unquoted is accepted single-quoted, and the same
    // character accepted in double quotes is refused unquoted. The distinction is
    // the quoting context, not the character.
    assert.throws(() => packagerExclusions(command('-e docs/notes;old')), /unmodelled shell syntax/);
    assert.deepEqual(packagerExclusions(command('-e \'docs/notes;old\'')), ['docs/notes;old']);
    assert.throws(() => packagerExclusions(command('-e docs/\\$notes.md')), /unmodelled shell syntax/);
    assert.deepEqual(packagerExclusions(command('-e \'docs/notes (old)\'')), ['docs/notes (old)']);
    assert.throws(() => packagerExclusions(command('-e docs/notes(old)')), /unmodelled shell syntax/);

    // What is NOT detected, and so limits what a green run here means: brace and
    // tilde expansion, an exclusion assembled across several words, and any command
    // built dynamically rather than written out literally. This test refuses the
    // constructs above; it does not certify that every value it accepts is what
    // bash would pass to tizen.
});

test('keeps development configuration and notes out of the TV package', () => {
    // Format pins only: these prove the flags are still spelled this way. The
    // parsed-path checks live in their own tests so that a failure here cannot
    // abort them -- the two failure modes are independently diagnosable.
    const packager = fs.readFileSync(path.join(root, 'scripts/package-wgt.sh'), 'utf8');

    assert.match(packager, /-e DETAIL_ACTIONS\.md/);
    assert.match(packager, /-e jellyquest\.config\.json/);
    assert.match(packager, /-e "artifacts\/\*"/);
    assert.match(packager, /-e "dev\/\*"/);
    assert.match(packager, /-e "docs\/\*"/);
    assert.match(packager, /-e "integration\/\*"/);
    assert.match(packager, /-e "scripts\/\*"/);
    assert.match(packager, /-e "src\/\*"/);
    assert.match(packager, /-e "test\/\*"/);
    assert.doesNotMatch(packager, /bridge\/\*/);
    // The Requests page copy is conditional (its integration/ source does not
    // exist at this commit); this pins that the copy step is still there, not
    // that the file ships.
    assert.match(packager, /www\/jellyseerr-login\.html/);
});

test('drops known internal paths from the TV package', () => {
    const packager = fs.readFileSync(path.join(root, 'scripts/package-wgt.sh'), 'utf8');
    const exclusions = packagerExclusions(packager);
    const internal = [
        'DETAIL_ACTIONS.md',
        'README.md',
        'gulpfile.babel.js',
        'jellyquest.config.json',
        'package.json',
        'package-lock.json',
        '.jellyfin-web-ref',
        'artifacts/JellyQuest.wgt',
        'dev/notes.md',
        'docs/rebuild-plan.md',
        'integration/jellyseerr-login.html',
        'node_modules/jellyfin-web/dist/index.html',
        'scripts/package-wgt.sh',
        'src/overlay/app.css',
        'test/configuration.test.mjs'
    ];

    for (const filePath of internal) {
        assert.ok(
            exclusions.some((pattern) => excludesPath(pattern, filePath)),
            `${filePath} is internal but no packager exclusion drops it`
        );
    }
});

test('keeps representative known runtime paths out of the packager exclusions', () => {
    // The outage this guards is the opposite of shipping an extra file: excluding
    // something the app needs still produces a signable WGT that installs and then
    // fails on the TV. config.xml names index.html as the widget content and
    // icon.png as the launcher icon; index.html redirects into www/, the gulp-built
    // Jellyfin Web tree, whose index.html loads ../tizen.js, ../jellyquest.js and
    // ../jellyquest.css from the package root (see gulpfile.babel.js modifyIndex).
    // jellyquest.js is also the only copy of the vendored spatial-navigation
    // polyfill in the package, because -e "node_modules/*" drops the installed one.
    //
    // www/jellyseerr-login.html is deliberately absent: its integration/ source
    // does not exist at this commit and both the packager and gulp copy it only
    // if present, so it is not required today.
    const packager = fs.readFileSync(path.join(root, 'scripts/package-wgt.sh'), 'utf8');
    const exclusions = packagerExclusions(packager);
    const required = [
        'config.xml',
        'index.html',
        'icon.png',
        'tizen.js',
        'jellyquest.js',
        'jellyquest.css',
        'www/index.html',
        'www/main.jellyfin.bundle.js',
        'www/assets/img/devices/tv.svg',
        // Written into www/ by scripts/configure-jellyquest.mjs. jellyquest-build.json
        // is fetched by src/overlay/app.js and supplies the Requests bridge URL --
        // without it Requests dead-ends on "Requests are not configured for this
        // server." config.json carries the configured server settings.
        'www/jellyquest-build.json',
        'www/config.json'
    ];

    // Positive controls: a floor, not a completeness proof. A negative result
    // only means something if the parser produced working patterns at all, so if
    // these stop matching, the checks below are passing vacuously. They do NOT
    // prove the parser read every exclusion -- a parser returning just these three
    // satisfies this test, and one that drops an additional dangerous exclusion
    // leaves every check here green. The internal-path test catches some, not all,
    // of that truncation.
    for (const sentinel of ['src/overlay/app.js', 'test/configuration.test.mjs', 'node_modules/jellyfin-web/dist/index.html']) {
        assert.ok(
            exclusions.some((pattern) => excludesPath(pattern, sentinel)),
            `positive control ${sentinel} is no longer excluded; the checks below cannot be trusted`
        );
    }

    for (const filePath of required) {
        const matched = exclusions.filter((pattern) => excludesPath(pattern, filePath));
        assert.deepEqual(
            matched,
            [],
            `${filePath} is needed on the TV but is excluded by ${matched.join(', ')}`
        );
    }
});

test('patches Jellyfin Web to handle generated detail playback actions', () => {
    const patcher = fs.readFileSync(path.join(root, 'scripts/patch-jellyfin-web.mjs'), 'utf8');

    assert.match(patcher, /itemShortcuts\.on\(view\.querySelector\('\.mainDetailButtons'\)\)/);
    assert.match(patcher, /itemShortcuts\.off\(view\.querySelector\('\.mainDetailButtons'\)\)/);
    assert.match(patcher, /mediaSourceId: card\.getAttribute\('data-mediasourceid'\)/);
    assert.match(patcher, /window\.playbackManager = playbackManager;/);
});

// Mirrors the pinned Jellyfin Web sources the patcher rewrites. The playback
// manager snippet is copied from .cache/jellyfin-web/src/components/playback/
// playbackmanager.js:4290-4292 at .jellyfin-web-ref -- upstream exports the
// singleton and never assigns it to a global.
function writePinnedWebFixture(webDirectory, overrides = {}) {
    const files = {
        'src/components/shortcuts.js': `function play() {
            playbackManager.play({
                ids: [playableItemId],
                startPositionTicks: startPositionTicks,
                serverId: serverId,
                queryOptions: {
                    SortBy: 'SortName'
                }
            });
}`,
        'src/controllers/itemDetails/index.js': `function bind(view) {
            itemShortcuts.on(view.querySelector('.nameContainer'));
            itemShortcuts.off(view.querySelector('.nameContainer'));
}`,
        'src/components/playback/playbackmanager.js': `import Events from '../../utils/events.ts';
export const playbackManager = new PlaybackManager();
bindMediaSegmentManager(playbackManager);
bindMediaSessionSubscriber(playbackManager);
`,
        ...overrides
    };

    for (const [relativePath, contents] of Object.entries(files)) {
        const absolutePath = path.join(webDirectory, relativePath);
        fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
        fs.writeFileSync(absolutePath, contents);
    }

    return files;
}

test('patches Jellyfin playback shortcuts with per-item stream selections', () => {
    const webDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'jellyquest-web-patch-'));
    writePinnedWebFixture(webDirectory);
    const shortcutsPath = path.join(webDirectory, 'src/components/shortcuts.js');
    const itemDetailsPath = path.join(webDirectory, 'src/controllers/itemDetails/index.js');

    const patcher = path.join(root, 'scripts/patch-jellyfin-web.mjs');
    const first = spawnSync(process.execPath, [patcher, webDirectory], { encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr);
    const patched = fs.readFileSync(shortcutsPath, 'utf8');
    assert.match(patched, /mediaSourceId: card\.getAttribute\('data-mediasourceid'\)/);
    assert.match(patched, /audioStreamIndex: optionalStreamIndex\('data-audiostreamindex'\)/);
    assert.match(patched, /subtitleStreamIndex: optionalStreamIndex\('data-subtitlestreamindex'\)/);
    const patchedItemDetails = fs.readFileSync(itemDetailsPath, 'utf8');
    assert.match(patchedItemDetails, /itemShortcuts\.on\(view\.querySelector\('\.mainDetailButtons'\)\)/);
    assert.match(patchedItemDetails, /itemShortcuts\.off\(view\.querySelector\('\.mainDetailButtons'\)\)/);

    const second = spawnSync(process.execPath, [patcher, webDirectory], { encoding: 'utf8' });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(fs.readFileSync(shortcutsPath, 'utf8'), patched);
    assert.equal(fs.readFileSync(itemDetailsPath, 'utf8'), patchedItemDetails);
});

// Presence of the assignment is not enough: a future patch that inserted it
// above the constructor call would read playbackManager in its temporal dead
// zone, which is exactly the failure mode that yields an undefined global.
// Ordering is therefore asserted, and the assertion itself is exercised against
// fabricated bad placements below.
function assertGlobalFollowsConstruction(source) {
    const construction = source.indexOf('export const playbackManager = new PlaybackManager();');
    const assignment = source.indexOf('window.playbackManager = playbackManager;');
    const segmentBinding = source.indexOf('bindMediaSegmentManager(playbackManager);');
    const sessionBinding = source.indexOf('bindMediaSessionSubscriber(playbackManager);');

    assert.notEqual(construction, -1, 'the singleton construction is missing');
    assert.notEqual(assignment, -1, 'the window.playbackManager assignment is missing');
    assert.notEqual(segmentBinding, -1, 'bindMediaSegmentManager is missing');
    assert.notEqual(sessionBinding, -1, 'bindMediaSessionSubscriber is missing');
    assert.ok(construction < assignment, 'the global must be assigned after the singleton is constructed');
    assert.ok(assignment < segmentBinding, 'the global must be assigned before the upstream binding calls');
    assert.ok(segmentBinding < sessionBinding, 'the upstream binding order must be preserved');
}

// The overlay's Play/Resume/Start Over and Trailer actions (src/overlay/app.js)
// call window.playbackManager.play(); nothing in the pinned Jellyfin Web build
// publishes that global, so the build-time patch has to. This exercises the
// patch logic only -- it cannot prove playback works on a real TV.
test('patches Jellyfin Web to publish the playback manager singleton as a global', () => {
    const webDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'jellyquest-web-global-'));
    const originalPlaybackManager = writePinnedWebFixture(webDirectory)['src/components/playback/playbackmanager.js'];
    const playbackManagerPath = path.join(webDirectory, 'src/components/playback/playbackmanager.js');
    assert.doesNotMatch(originalPlaybackManager, /window\.playbackManager/);

    const patcher = path.join(root, 'scripts/patch-jellyfin-web.mjs');
    const first = spawnSync(process.execPath, [patcher, webDirectory], { encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr);
    const patched = fs.readFileSync(playbackManagerPath, 'utf8');
    assert.match(patched, /^window\.playbackManager = playbackManager;$/m);
    // The global has to be the exported singleton, not a second manager.
    assert.match(patched, /export const playbackManager = new PlaybackManager\(\);/);
    assert.equal(patched.match(/new PlaybackManager\(\)/g).length, 1);
    assertGlobalFollowsConstruction(patched);

    const second = spawnSync(process.execPath, [patcher, webDirectory], { encoding: 'utf8' });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(fs.readFileSync(playbackManagerPath, 'utf8'), patched);
});

// Fabricated bad patches: the ordering assertion above is only worth having if
// it rejects these, so prove it does rather than only checking the good state.
test('rejects a playback manager global assigned outside its patched position', () => {
    const beforeConstruction = `window.playbackManager = playbackManager;
export const playbackManager = new PlaybackManager();
bindMediaSegmentManager(playbackManager);
bindMediaSessionSubscriber(playbackManager);
`;
    assert.throws(
        () => assertGlobalFollowsConstruction(beforeConstruction),
        /the global must be assigned after the singleton is constructed/
    );

    const afterBindings = `export const playbackManager = new PlaybackManager();
bindMediaSegmentManager(playbackManager);
bindMediaSessionSubscriber(playbackManager);
window.playbackManager = playbackManager;
`;
    assert.throws(
        () => assertGlobalFollowsConstruction(afterBindings),
        /the global must be assigned before the upstream binding calls/
    );

    // Unpatched pinned source: no assignment at all.
    assert.throws(
        () => assertGlobalFollowsConstruction(`export const playbackManager = new PlaybackManager();
bindMediaSegmentManager(playbackManager);
bindMediaSessionSubscriber(playbackManager);
`),
        /the window\.playbackManager assignment is missing/
    );
});

// A silent no-op on the next .jellyfin-web-ref bump would restore the runtime
// crash, so drifted anchors must fail the build instead. Each variant is a way
// the pinned declaration could plausibly be rewritten upstream.
test('fails loudly when the pinned playback manager singleton no longer matches', () => {
    const driftVariants = {
        'a renamed constructor': 'export const playbackManager = new PlaybackManagerV2();\n',
        'a dropped semicolon': 'export const playbackManager = new PlaybackManager()\n',
        'doubled internal whitespace': 'export  const  playbackManager  =  new  PlaybackManager();\n',
        'a multiline declaration': 'export const playbackManager =\n    new PlaybackManager();\n'
    };
    const patcher = path.join(root, 'scripts/patch-jellyfin-web.mjs');

    for (const [label, drifted] of Object.entries(driftVariants)) {
        const webDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'jellyquest-web-drift-'));
        const playbackManagerPath = path.join(webDirectory, 'src/components/playback/playbackmanager.js');
        writePinnedWebFixture(webDirectory, { 'src/components/playback/playbackmanager.js': drifted });

        const result = spawnSync(process.execPath, [patcher, webDirectory], { encoding: 'utf8' });
        assert.equal(result.status, 1, `${label} should fail the build, got status ${result.status}`);
        assert.match(result.stderr, /Pinned Jellyfin Web playback manager singleton no longer matches/, label);
        assert.match(result.stderr, /update the JellyQuest patch/, label);
        // A failed run must not leave a half-patched file behind.
        assert.equal(fs.readFileSync(playbackManagerPath, 'utf8'), drifted, label);
    }
});

test('installs through the direct Samsung TV workflow', () => {
    const launcher = fs.readFileSync(path.join(root, 'scripts/install-tv.sh'), 'utf8');
    const installer = fs.readFileSync(path.join(root, 'scripts/install-wgt.sh'), 'utf8');

    assert.match(launcher, /docker run --rm --network host/);
    assert.match(installer, /sdb connect/);
    assert.match(installer, /vd_appuninstall/);
    assert.match(installer, /vd_appinstall/);
    assert.match(installer, /vd_applist/);
    assert.match(installer, /execute/);
    assert.match(installer, /app_version/);
});

test('playback event bridge is idempotent and fails loudly on import or bridge drift', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jellyquest-events-'));
    try {
        writePinnedWebFixture(directory);
        const sourcePath = path.join(directory, 'src/components/playback/playbackmanager.js');
        const patch = () => spawnSync(process.execPath, [path.join(root, 'scripts/patch-jellyfin-web.mjs'), directory], { encoding: 'utf8' });
        assert.equal(patch().status, 0);
        const source = fs.readFileSync(sourcePath, 'utf8');
        assert.match(source, /Events\.on\(playbackManager, type, callback\)/);
        assert.match(source, /if \(window.JellyQuestBindPlayback\) window.JellyQuestBindPlayback\(\)/);
        assert.equal(patch().status, 0);
        assert.equal(fs.readFileSync(sourcePath, 'utf8'), source);
        for (const damaged of [
            source.replace("import Events from '../../utils/events.ts';", ''),
            source.replace('Events.on(playbackManager, type, callback)', 'Events.on(other, type, callback)')
        ]) {
            fs.writeFileSync(sourcePath, damaged);
            const result = patch();
            assert.notEqual(result.status, 0);
            assert.match(result.stderr, /playback event bridge no longer matches/);
        }
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
