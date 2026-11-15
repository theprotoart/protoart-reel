// Computes waveform peaks (100 per second, 0..1) for a media file's audio, off the main thread.
// (Used when the Rust core isn't in this build or can't read the file; see peaks.js.)
import { openAudio } from './lib/sources.js';
import { peaksOf } from './lib/analysis.js';

self.onmessage = async e => {
  const { id, url, file } = e.data;
  try {
    const a = await openAudio(url, file);
    if (!a) return self.postMessage({ id, peaks: null });
    const peaks = await peaksOf(a);
    a.close();
    self.postMessage({ id, peaks }, [peaks.data.buffer]);
  } catch {
    self.postMessage({ id, peaks: null });
  }
};
