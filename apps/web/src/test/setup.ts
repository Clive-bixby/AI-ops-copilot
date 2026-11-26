import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

/**
 * One teardown for every test file.
 *
 * RTL only auto-cleans when the test globals exist, and this suite imports
 * `describe`/`it` explicitly, so cleanup is registered here. Global stubs
 * (`fetch`, timers) are removed too, so a mock set up in one file cannot leak
 * into the next.
 */
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});
