import createModule from './sherpa-onnx-wasm-main-tts.js';
import { createOfflineTts, getDefaultOfflineTtsModelType } from './sherpa-onnx-tts.js';
import {
  MODEL_CHUNKS,
  MODEL_COMPRESSED_SIZE,
  MODEL_PACKAGE_SIZE,
  MODEL_VERSION,
} from './model-manifest.js';

const CACHE_PREFIX = 'shiyun-melo-';
const CACHE_NAME = `${CACHE_PREFIX}${MODEL_VERSION}-q8-gzip-v2`;
const DOWNLOAD_CONCURRENCY = 4;
const DOWNLOAD_ATTEMPTS = 3;
const chunkProgress = MODEL_CHUNKS.map(() => 0);
let lastProgressAt = 0;
let lastPercent = -1;

function reportProgress(source, force = false) {
  const loadedCompressed = chunkProgress.reduce((sum, value) => sum + value, 0);
  const percent = Math.min(100, Math.round((loadedCompressed / MODEL_COMPRESSED_SIZE) * 100));
  const now = performance.now();
  if (!force && percent === lastPercent && now - lastProgressAt < 120) return;
  lastPercent = percent;
  lastProgressAt = now;
  self.postMessage({
    type: 'melo-progress',
    phase: 'model',
    source,
    loaded: loadedCompressed,
    total: MODEL_COMPRESSED_SIZE,
    percent,
  });
}

async function openModelCache() {
  if (!('caches' in self)) return null;
  const names = await caches.keys();
  await Promise.all(names
    .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
    .map((name) => caches.delete(name)));
  return caches.open(CACHE_NAME);
}

async function loadModelPackage() {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('当前浏览器不支持模型解压，请升级 Chrome、Edge、Firefox 或 Safari');
  }

  const cache = await openModelCache();
  const packageBytes = new Uint8Array(MODEL_PACKAGE_SIZE);
  let cacheWarningSent = false;
  const offsets = [];
  MODEL_CHUNKS.reduce((offset, chunk) => {
    offsets.push(offset);
    return offset + chunk.rawSize;
  }, 0);

  async function loadChunk(index) {
    const chunk = MODEL_CHUNKS[index];
    const url = new URL(chunk.file, import.meta.url);
    for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
      let cacheWrite = null;
      let controller = null;
      let timeout = 0;
      try {
        chunkProgress[index] = 0;
        let response = attempt === 1 && cache ? await cache.match(url) : undefined;
        const source = response ? 'cache' : 'network';
        if (!response) {
          controller = new AbortController();
          timeout = setTimeout(() => controller.abort(), 120_000);
          response = await fetch(url, {
            cache: attempt === 1 ? 'force-cache' : 'reload',
            signal: controller.signal,
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          if (cache) cacheWrite = cache.put(url, response.clone()).catch(() => false);
        }
        if (!response.body) throw new Error('浏览器未返回可读取的数据流');

        const monitored = response.body.pipeThrough(new TransformStream({
          transform(bytes, streamController) {
            chunkProgress[index] += bytes.byteLength;
            reportProgress(source);
            streamController.enqueue(bytes);
          },
        }));
        const raw = await new Response(
          monitored.pipeThrough(new DecompressionStream('gzip')),
        ).arrayBuffer();
        if (raw.byteLength !== chunk.rawSize) {
          throw new Error(`分片损坏：${raw.byteLength}/${chunk.rawSize}`);
        }
        packageBytes.set(new Uint8Array(raw), offsets[index]);
        if (cacheWrite && await cacheWrite === false) cacheWarningSent = true;
        if (timeout) clearTimeout(timeout);
        return;
      } catch (error) {
        if (timeout) clearTimeout(timeout);
        await cacheWrite;
        if (cache) await cache.delete(url);
        if (attempt === DOWNLOAD_ATTEMPTS) {
          throw new Error(`模型分片 ${index + 1} 加载失败：${error instanceof Error ? error.message : String(error)}`);
        }
        self.postMessage({
          type: 'melo-progress',
          phase: 'model',
          source: 'network',
          percent: Math.round((chunkProgress.reduce((sum, value) => sum + value, 0) / MODEL_COMPRESSED_SIZE) * 100),
          status: `网络波动，正在重试 ${attempt + 1}/${DOWNLOAD_ATTEMPTS}`,
        });
        await new Promise((resolve) => setTimeout(resolve, 450 * attempt));
      }
    }
  }

  let nextChunk = 0;
  const runner = async () => {
    while (nextChunk < MODEL_CHUNKS.length) {
      const index = nextChunk;
      nextChunk += 1;
      await loadChunk(index);
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(DOWNLOAD_CONCURRENCY, MODEL_CHUNKS.length) },
    runner,
  ));

  if (cacheWarningSent) self.postMessage({ type: 'melo-cache-warning' });

  reportProgress('ready', true);
  return packageBytes.buffer;
}

let tts = null;

try {
  if (!self.crossOriginIsolated) {
    throw new Error('高音质模型需要跨源隔离，请刷新页面后重试');
  }
  self.postMessage({ type: 'melo-progress', phase: 'runtime', percent: 0 });
  const Module = await createModule({
    locateFile: (path) => new URL(path, import.meta.url).href,
    getPreloadedPackage: () => loadModelPackage(),
    setStatus: (status) => self.postMessage({
      type: 'melo-progress',
      phase: 'runtime',
      percent: 100,
      status,
    }),
  });
  tts = createOfflineTts(Module);
  self.postMessage({
    type: 'melo-ready',
    modelType: getDefaultOfflineTtsModelType(),
    numSpeakers: tts.numSpeakers,
  });
} catch (error) {
  self.postMessage({
    type: 'melo-error',
    message: error instanceof Error ? error.message : String(error),
  });
}

self.onmessage = (event) => {
  const { type, requestId, text, sid, speed } = event.data;
  if (type !== 'generate' || !tts) return;
  try {
    const audio = tts.generate({ text, sid: sid ?? 0, speed: speed ?? 1 });
    self.postMessage({
      type: 'melo-result',
      requestId,
      samples: audio.samples,
      sampleRate: tts.sampleRate,
    }, [audio.samples.buffer]);
  } catch (error) {
    self.postMessage({
      type: 'melo-error',
      requestId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
