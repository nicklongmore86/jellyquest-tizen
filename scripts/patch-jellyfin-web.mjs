import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const webDirectory = path.resolve(process.argv[2] || '');
const shortcutsPath = path.join(webDirectory, 'src/components/shortcuts.js');
const itemDetailsPath = path.join(webDirectory, 'src/controllers/itemDetails/index.js');
const playbackManagerPath = path.join(webDirectory, 'src/components/playback/playbackmanager.js');
const shortcutsSource = fs.readFileSync(shortcutsPath, 'utf8');
const originalPlaybackOptions = `            playbackManager.play({
                ids: [playableItemId],
                startPositionTicks: startPositionTicks,
                serverId: serverId,
                queryOptions: {`;
const patchedPlaybackOptions = `            const optionalStreamIndex = name => {
                const value = card.getAttribute(name);
                return value == null || value === '' ? undefined : parseInt(value, 10);
            };
            playbackManager.play({
                ids: [playableItemId],
                startPositionTicks: startPositionTicks,
                serverId: serverId,
                mediaSourceId: card.getAttribute('data-mediasourceid') || undefined,
                audioStreamIndex: optionalStreamIndex('data-audiostreamindex'),
                subtitleStreamIndex: optionalStreamIndex('data-subtitlestreamindex'),
                queryOptions: {`;

if (shortcutsSource.includes(patchedPlaybackOptions)) {
    console.info('JellyQuest playback-option patch already applied');
} else if (shortcutsSource.includes(originalPlaybackOptions)) {
    fs.writeFileSync(shortcutsPath, shortcutsSource.replace(originalPlaybackOptions, patchedPlaybackOptions));
    console.info('Applied JellyQuest playback-option patch');
} else {
    throw new Error('Pinned Jellyfin Web shortcuts playback block no longer matches; update the JellyQuest patch');
}

const itemDetailsSource = fs.readFileSync(itemDetailsPath, 'utf8');
const originalPlaybackBinding = `            itemShortcuts.on(view.querySelector('.nameContainer'));`;
const patchedPlaybackBinding = `            itemShortcuts.on(view.querySelector('.nameContainer'));
            itemShortcuts.on(view.querySelector('.mainDetailButtons'));`;
const originalPlaybackUnbinding = `            itemShortcuts.off(view.querySelector('.nameContainer'));`;
const patchedPlaybackUnbinding = `            itemShortcuts.off(view.querySelector('.nameContainer'));
            itemShortcuts.off(view.querySelector('.mainDetailButtons'));`;

if (itemDetailsSource.includes(patchedPlaybackBinding) && itemDetailsSource.includes(patchedPlaybackUnbinding)) {
    console.info('JellyQuest generated detail-action binding patch already applied');
} else if (itemDetailsSource.includes(originalPlaybackBinding) && itemDetailsSource.includes(originalPlaybackUnbinding)) {
    fs.writeFileSync(itemDetailsPath, itemDetailsSource
        .replace(originalPlaybackBinding, patchedPlaybackBinding)
        .replace(originalPlaybackUnbinding, patchedPlaybackUnbinding));
    console.info('Applied JellyQuest generated detail-action binding patch');
} else {
    throw new Error('Pinned Jellyfin Web detail-action binding block no longer matches; update the JellyQuest patch');
}

const playbackManagerSource = fs.readFileSync(playbackManagerPath, 'utf8');
const originalPlaybackManagerSingleton = `export const playbackManager = new PlaybackManager();`;
const patchedPlaybackManagerSingleton = `export const playbackManager = new PlaybackManager();
// JellyQuest's overlay is a plain script loaded beside the Jellyfin Web bundle,
// so it cannot import this module. Publish the singleton -- never a second
// manager -- as the global the overlay's playback actions call.
window.playbackManager = playbackManager;`;

if (playbackManagerSource.includes(patchedPlaybackManagerSingleton)) {
    console.info('JellyQuest playback-manager global patch already applied');
} else if (playbackManagerSource.includes(originalPlaybackManagerSingleton)) {
    fs.writeFileSync(playbackManagerPath, playbackManagerSource.replace(originalPlaybackManagerSingleton, patchedPlaybackManagerSingleton));
    console.info('Applied JellyQuest playback-manager global patch');
} else {
    throw new Error('Pinned Jellyfin Web playback manager singleton no longer matches; update the JellyQuest patch');
}

// Publish Events.on through a narrow bridge; never read upstream _callbacks.
// Check the import as well as the singleton: a renamed Events must fail at build.
const eventSource = fs.readFileSync(playbackManagerPath, 'utf8');
const eventAnchor = 'window.playbackManager = playbackManager;';
const eventPatch = `${eventAnchor}
window.JellyQuestPlaybackEvents = function (type, callback) {
    Events.on(playbackManager, type, callback);
};
if (window.JellyQuestBindPlayback) window.JellyQuestBindPlayback();`;
if (!eventSource.includes("import Events from '../../utils/events.ts';")
    || !eventSource.includes(eventAnchor)) {
    throw new Error('Pinned Jellyfin Web playback event bridge no longer matches; update the JellyQuest patch');
}
if (eventSource.includes(eventPatch)) {
    console.info('JellyQuest playback event bridge already applied');
} else if (eventSource.includes('window.JellyQuestPlaybackEvents')) {
    throw new Error('Pinned Jellyfin Web playback event bridge no longer matches; update the JellyQuest patch');
} else {
    fs.writeFileSync(playbackManagerPath, eventSource.replace(eventAnchor, eventPatch));
    console.info('Applied JellyQuest playback event bridge');
}
