import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import axios from 'axios';
import express from 'express';
import { getAddonInterface } from '../addon.js';
import { serverless } from '../serverless.js';
import { parseConfiguration } from '../lib/configuration.js';
import { applyMochs } from '../moch/moch.js';
import { applyFilters } from '../lib/filter.js';
import { prewarm, resolve, selectRequestedVideo } from '../moch/realdebrid.js';

const key = 'test-real-debrid-api-key';
const hash = 'a'.repeat(40);
const episode = 'tt9001001:1:3';
const configString = `RD=${key}|languages=en|prewarm=0`;
function config(overrides = {}) {
  return { ...parseConfiguration(configString), _configString: configString,
    _publicBaseUrl: 'https://addon.example', ...overrides };
}
const rawStream = { infoHash: hash, name: 'Magnetio 720p', title: 'Series S01E03',
  behaviorHints: { filename: 'Series.S01E03.mkv' } };
const files = [
  { id: 7, path: '/readme.txt', bytes: 100, selected: 0 },
  { id: 42, path: '/Series.S01E03.mkv', bytes: 5000, selected: 0 },
];

test('installer adverts in episode search results cannot reach playback or automatic prewarm', () => {
  const records = [
    { title: 'Series.S01E03.720p.mkv' },
    { title: 'Series S01E03 - Downloader.dmg' },
    { fileName: 'setup.EXE', title: 'Series S01E03' },
  ];
  assert.deepEqual(applyFilters(records, {}), [records[0]]);
});

test('RD listing keeps uncached candidates beyond the old five-result cap without starting downloads', async t => {
  const get = t.mock.method(axios, 'get', async (url, options) => {
    assert.ok(url.endsWith('/torrents'));
    assert.equal(options.timeout, 2000);
    return { data: [] };
  });
  const post = t.mock.method(axios, 'post', () => { throw new Error('Browsing must not start downloads'); });
  const del = t.mock.method(axios, 'delete', () => { throw new Error('Browsing must not delete downloads'); });
  const input = Array.from({ length: 8 }, (_, i) => ({ ...rawStream, infoHash: String(i).repeat(40) }));
  const streams = await applyMochs(input, config({ prewarmDebrid: false }), { id: episode });
  assert.equal(streams.length, 8);
  for (const stream of streams) {
    assert.equal(stream.infoHash, undefined);
    assert.equal(stream.sources, undefined);
    const url = new URL(stream.url);
    assert.match(url.pathname, /\/resolve\/rd\/[a-f0-9]{40}\/auto$/);
    assert.equal(url.searchParams.get('videoId'), episode);
    assert.match(stream.title, /press play to download/);
  }
  assert.equal(get.mock.callCount(), 1);
  assert.equal(post.mock.callCount(), 0);
  assert.equal(del.mock.callCount(), 0);
});

test('RD library misses and temporary lookup failures do not hide candidates', async t => {
  t.mock.method(axios, 'get', async () => { throw new Error('upstream timeout'); });
  const streams = await applyMochs([rawStream], config(), { id: episode });
  assert.equal(streams.length, 1);
  assert.match(streams[0].url, /\/resolve\/rd\//);
});

test('an invalid configured debrid token never silently exposes direct P2P streams', async () => {
  assert.deepEqual(await applyMochs([rawStream], config({ realDebridApiKey: 'short' }), {}), []);
  assert.deepEqual(await applyMochs([rawStream], parseConfiguration(''), {}), [rawStream]);
});

test('ready RD items sort first; explicitly disabling on-demand still hides uncached items', async t => {
  const readyHash = 'b'.repeat(40);
  t.mock.method(axios, 'get', async () => ({ data: [{ hash: readyHash, status: 'downloaded' }] }));
  const inputs = [rawStream, { ...rawStream, infoHash: readyHash }];
  const all = await applyMochs(inputs, config(), { id: episode });
  assert.equal(all.length, 2);
  assert.match(all[0].url, new RegExp(readyHash));
  assert.match(all[0].name, /⚡\]/);
  const readyOnly = await applyMochs(inputs, config({ onDemand: false }), { id: episode });
  assert.equal(readyOnly.length, 1);
  assert.match(readyOnly[0].url, new RegExp(readyHash));
});

test('RD file selection uses real file IDs and selects the requested episode within a pack', () => {
  const pack = [...files, { id: 90, path: '/Series.S01E04.mkv', bytes: 99999 }];
  assert.equal(selectRequestedVideo(pack, { videoId: episode }).id, 42);
  assert.equal(selectRequestedVideo(pack, { fileIdx: 1 }).id, 42);
  assert.equal(selectRequestedVideo(pack, { fileIdx: 0 }), null);
  assert.equal(selectRequestedVideo(pack, { videoId: 'tt9001001:1:5' }), null);
  assert.equal(selectRequestedVideo([{ id: 1, path: 'Downloader.dmg' }], {}), null);
  assert.equal(selectRequestedVideo([{ id: 1, path: 'Series.S01E04.mkv' }], { videoId: episode }), null);
});

function mockDownload(t, { alreadyReady = false } = {}) {
  const actions = [];
  let selected = alreadyReady;
  t.mock.method(axios, 'get', async url => {
    actions.push(['GET', url]);
    if (url.endsWith('/torrents')) return { data: alreadyReady ? [{ hash, id: 'job', status: 'downloaded' }] : [] };
    assert.ok(url.endsWith('/torrents/info/job'));
    return { data: { id: 'job', status: selected ? 'downloaded' : 'waiting_files_selection',
      files: files.map(f => ({ ...f, selected: selected && f.id === 42 ? 1 : 0 })),
      links: selected ? ['https://rd.example/episode3'] : [] } };
  });
  t.mock.method(axios, 'post', async (url, body) => {
    const values = Object.fromEntries(new URLSearchParams(body));
    actions.push(['POST', url, values]);
    if (url.endsWith('/addMagnet')) {
      assert.equal(values.magnet, `magnet:?xt=urn:btih:${hash}`);
      return { data: { id: 'job' } };
    }
    if (url.endsWith('/selectFiles/job')) {
      assert.equal(values.files, '42');
      selected = true;
      return { data: null };
    }
    assert.ok(url.endsWith('/unrestrict/link'));
    assert.equal(values.link, 'https://rd.example/episode3');
    return { data: { download: 'https://cdn.example/episode3.mkv' } };
  });
  return actions;
}

test('uncached playback adds magnet, selects the video ID and returns its unrestricted link', async t => {
  const actions = mockDownload(t);
  const url = await resolve({ infoHash: hash, videoId: episode }, key);
  assert.equal(url, 'https://cdn.example/episode3.mkv');
  assert.deepEqual(actions.filter(a => a[0] === 'POST').map(a => a[1].split('/').slice(-2).join('/')),
    ['torrents/addMagnet', 'selectFiles/job', 'unrestrict/link']);
});

test('already-downloaded playback reuses the job and never selects or downloads it again', async t => {
  const actions = mockDownload(t, { alreadyReady: true });
  assert.equal(await resolve({ infoHash: hash, videoId: episode }, key), 'https://cdn.example/episode3.mkv');
  assert.equal(actions.filter(a => a[0] === 'POST').length, 1);
});

test('simultaneous play requests share one RD download job', async t => {
  const actions = mockDownload(t);
  const streams = await Promise.all([resolve({ infoHash: hash }, key), resolve({ infoHash: hash }, key)]);
  assert.deepEqual(streams, ['https://cdn.example/episode3.mkv', 'https://cdn.example/episode3.mkv']);
  assert.equal(actions.filter(a => a[1].endsWith('/addMagnet')).length, 1);
});

test('pressing play during prewarm reuses the same preparation and RD job', async t => {
  const actions = mockDownload(t);
  const stream = { infoHash: hash, videoId: episode };
  const [warmed, url] = await Promise.all([prewarm(stream, key), resolve(stream, key)]);
  assert.equal(warmed, true);
  assert.equal(url, 'https://cdn.example/episode3.mkv');
  assert.equal(actions.filter(a => a[1].endsWith('/addMagnet')).length, 1);
  assert.equal(actions.filter(a => a[1].endsWith('/selectFiles/job')).length, 1);
});

test('background prewarm starts only the configured top results, never delays listing and deduplicates refreshes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let libraryCalls = 0;
  const added = [];
  const selected = [];
  t.mock.method(axios, 'get', async url => {
    if (url.endsWith('/torrents')) {
      if (++libraryCalls > 1) await gate;
      return { data: [] };
    }
    return { data: { status: 'waiting_files_selection', files } };
  });
  t.mock.method(axios, 'post', async (url, body) => {
    const values = new URLSearchParams(body);
    if (url.endsWith('/addMagnet')) {
      const hash = values.get('magnet').split(':').at(-1);
      added.push(hash);
      return { data: { id: hash } };
    }
    assert.match(url, /\/selectFiles\//);
    selected.push(values.get('files'));
    return { data: null };
  });
  const inputs = ['c', 'd', 'e'].map(c => ({ ...rawStream, infoHash: c.repeat(40) }));
  const settings = config({ prewarmDebrid: true, prewarmLimit: 2 });
  const result = await applyMochs(inputs, settings, { id: episode });
  assert.equal(result.length, 3);
  assert.equal(added.length, 0);
  t.mock.timers.tick(0);
  for (let i = 0; i < 5; i++) await setImmediate();
  assert.equal(libraryCalls, 3); // list + two background preparations, both still blocked
  release();
  for (let i = 0; i < 10; i++) await setImmediate();
  assert.deepEqual(added, ['c'.repeat(40), 'd'.repeat(40)]);
  assert.deepEqual(selected, ['42', '42']);
  await applyMochs(inputs, settings, { id: episode });
  t.mock.timers.tick(0);
  for (let i = 0; i < 5; i++) await setImmediate();
  assert.equal(added.length, 2);
});

test('retry chooses an existing job for this episode instead of duplicating another episode selection', async t => {
  t.mock.method(axios, 'get', async url => {
    if (url.endsWith('/torrents')) return { data: [
      { hash, id: 'other', status: 'downloaded' }, { hash, id: 'target', status: 'downloaded' },
    ] };
    const target = url.endsWith('/target');
    return { data: { status: 'downloaded', files: [
      { ...files[1], selected: target ? 1 : 0 },
      { id: 90, path: '/Series.S01E04.mkv', selected: target ? 0 : 1 },
    ], links: [target ? 'https://rd.example/episode3' : 'https://rd.example/episode4'] } };
  });
  const post = t.mock.method(axios, 'post', async (url, body) => {
    assert.ok(url.endsWith('/unrestrict/link'));
    assert.equal(new URLSearchParams(body).get('link'), 'https://rd.example/episode3');
    return { data: { download: 'https://cdn.example/episode3.mkv' } };
  });
  assert.equal(await resolve({ infoHash: hash, videoId: episode }, key), 'https://cdn.example/episode3.mkv');
  assert.equal(post.mock.callCount(), 1);
});

test('unfinished RD download is retained and reused successfully on a later attempt', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let downloaded = false;
  let adds = 0;
  let exists = false;
  t.mock.method(axios, 'get', async url => ({ data: url.endsWith('/torrents')
    ? (exists ? [{ hash, id: 'pending', status: downloaded ? 'downloaded' : 'downloading' }] : [])
    : { status: downloaded ? 'downloaded' : 'downloading', files: [{ ...files[1], selected: 1 }],
      links: downloaded ? ['https://rd.example/episode3'] : [] } }));
  t.mock.method(axios, 'post', async url => {
    if (url.endsWith('/addMagnet')) { adds++; exists = true; return { data: { id: 'pending' } }; }
    assert.ok(url.endsWith('/unrestrict/link'));
    return { data: { download: 'https://cdn.example/episode3.mkv' } };
  });
  const del = t.mock.method(axios, 'delete', () => { throw new Error('Do not delete pending downloads'); });
  const pending = resolve({ infoHash: hash, videoId: episode }, key);
  for (let i = 0; i < 12; i++) { await setImmediate(); t.mock.timers.tick(2000); }
  assert.equal(await pending, null);
  downloaded = true;
  assert.equal(await resolve({ infoHash: hash, videoId: episode }, key), 'https://cdn.example/episode3.mkv');
  assert.equal(adds, 1);
  assert.equal(del.mock.callCount(), 0);
});

test('resolve HTTP endpoint selects the requested episode and redirects without caching the account link', async t => {
  mockDownload(t);
  const app = express().use(serverless);
  const server = app.listen(0, '127.0.0.1');
  t.after(() => { server.closeAllConnections(); server.close(); });
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const route = `${base}/${encodeURIComponent(configString)}/resolve/rd/${hash}/auto?videoId=${encodeURIComponent(episode)}`;
  const response = await fetch(route, { redirect: 'manual' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), 'https://cdn.example/episode3.mkv');
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal((await fetch(route.replace('/auto?', '/-1?'))).status, 400);
});

test('simultaneous searches complete for every caller and do not mix quality configurations', async t => {
  const records = [
    { infoHash: hash, title: 'Series.S01E03.720p', quality: '720p', languages: ['en'] },
    { infoHash: 'b'.repeat(40), title: 'Series.S01E03.1080p', quality: '1080p', languages: ['en'] },
  ];
  t.mock.method(axios, 'get', async () => { await setImmediate(); return { data: { streams: records } }; });
  const low = await getAddonInterface(parseConfiguration('qualities=720p'));
  const high = await getAddonInterface(parseConfiguration('qualities=1080p'));
  let timer;
  t.after(() => clearTimeout(timer));
  const result = await Promise.race([
    Promise.all([low.get('stream', 'series', episode), low.get('stream', 'series', episode), high.get('stream', 'series', episode)]),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('A caller was left hanging')), 1000); }),
  ]);
  assert.deepEqual(result[0], result[1]);
  assert.equal(result[0].streams[0].infoHash, hash);
  assert.equal(result[2].streams[0].infoHash, 'b'.repeat(40));
});

test('P2P proxy preference cannot strip hashes needed for RD resolution', async t => {
  t.mock.method(axios, 'get', async url => ({ data: url.endsWith('/torrents') ? [] : {
    streams: [{ infoHash: hash, title: 'Series.S01E03.720p', quality: '720p', languages: ['en'] }],
  } }));
  const addon = await getAddonInterface(config({ proxyStreams: true }));
  const result = await addon.get('stream', 'series', 'tt9001002:1:3');
  assert.equal(result.streams.length, 1);
  assert.match(result.streams[0].url, /\/resolve\/rd\//);
  assert.equal(result.streams[0].infoHash, undefined);
});
