// Builds the shipped jellyquest.js / jellyquest.css from src/overlay/*.
//
// JellyQuest deliberately avoids native ES modules (<script type="module">).
// The reason once given here -- that the oldest TV's Chromium predates them
// -- was wrong: modules landed in Chromium 61, and the measured floor is
// Tizen 5.0 / Chromium M63, so both sets can parse them. See the README's
// "Target hardware" section. What actually remains is weaker and explicitly
// UNTESTED: the packaged app is loaded from a `file://` URL (observed on
// both sets, though how the runtime treats that origin is not established)
// and module fetches are CORS-governed. Nobody has tried a real module graph
// inside Samsung's runtime, and concatenation avoids the question at no
// cost -- an untested compatibility concern, not a proven device limitation.
//
// So source lives as separate, named files under src/overlay/ for
// maintainability, and this script concatenates them -- in an explicit
// order, not directory/glob order -- into the single
// jellyquest.js/jellyquest.css files gulpfile.babel.js injects.
//
// The vendored spatial-navigation-polyfill is prepended first so every
// overlay module can rely on window.navigate() / window.JellyQuestFocus
// being ready.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const JS_FILES = [
    path.join(root, 'node_modules/spatial-navigation-polyfill/polyfill/spatial-navigation-polyfill.js'),
    path.join(root, 'src/overlay/focus.js'),
    path.join(root, 'src/overlay/session.js'),
    path.join(root, 'src/overlay/cards.js'),
    path.join(root, 'src/overlay/requests-bridge.js'),
    path.join(root, 'src/overlay/screens/profiles.js'),
    path.join(root, 'src/overlay/screens/home.js'),
    path.join(root, 'src/overlay/screens/library.js'),
    path.join(root, 'src/overlay/screens/search.js'),
    path.join(root, 'src/overlay/screens/detail.js'),
    path.join(root, 'src/overlay/screens/series.js'),
    path.join(root, 'src/overlay/screens/requests.js'),
    path.join(root, 'src/overlay/shell.js'),
    // app.js must come last: it's the one that actively calls into the
    // other modules' globals (JellyQuestFocus.ready(), etc.) rather than
    // just defining its own.
    path.join(root, 'src/overlay/app.js'),
];

const CSS_FILES = [
    path.join(root, 'src/overlay/focus.css'),
    path.join(root, 'src/overlay/app.css'),
    path.join(root, 'src/overlay/shell.css'),
    path.join(root, 'src/overlay/cards.css'),
    path.join(root, 'src/overlay/screens/profiles.css'),
    path.join(root, 'src/overlay/screens/home.css'),
    path.join(root, 'src/overlay/screens/library.css'),
    path.join(root, 'src/overlay/screens/search.css'),
    path.join(root, 'src/overlay/screens/detail.css'),
    path.join(root, 'src/overlay/screens/requests.css'),
];

function concatenate(files, outputPath, banner) {
    const parts = files.map((file) => {
        if (!fs.existsSync(file)) {
            throw new Error(`build-overlay: expected source file is missing: ${path.relative(root, file)}`);
        }
        const relative = path.relative(root, file);
        return `/* ---- ${relative} ---- */\n${fs.readFileSync(file, 'utf8').replace(/\s+$/, '')}\n`;
    });
    fs.writeFileSync(outputPath, `${banner}\n\n${parts.join('\n')}`);
    console.info(`Wrote ${path.relative(root, outputPath)} from ${files.length} source file(s)`);
}

concatenate(
    JS_FILES,
    path.join(root, 'jellyquest.js'),
    '// GENERATED FILE -- do not edit directly.\n// Edit src/overlay/*.js and re-run `node scripts/build-overlay.mjs` (or `npm run build`).'
);

concatenate(
    CSS_FILES,
    path.join(root, 'jellyquest.css'),
    '/* GENERATED FILE -- do not edit directly.\n   Edit src/overlay/*.css and re-run `node scripts/build-overlay.mjs` (or `npm run build`). */'
);
