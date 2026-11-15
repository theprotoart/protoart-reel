// Loudness profile of a media file's sound for AUTO MIX: the K-weighted mean square of every 100 ms
// (ITU-R BS.1770, the same weighting as the export's loudness meter), off the main thread.
// (Used when the Rust core isn't in this build or can't read the file; see automix.js.)
import { openAudio } from './lib/sources.js';
import { levelsOf } from './lib/analysis.js';

self.onmessage = async e => {
  const { id, url, file } = e.data;
  try {
    const a = await openAudio(url, file);
    if (!a) return self.postMessage({ id, profile: null });
    const profile = await levelsOf(a);
    a.close();
    self.postMessage({ id, profile }, [profile.steps.buffer]);
  } catch (err) {
    self.postMessage({ id, profile: null, error: String(err?.message || err) });
  }
};
