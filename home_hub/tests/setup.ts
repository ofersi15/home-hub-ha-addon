import { setLogSink } from '../src/log.js';

// Keep test output quiet; set TEST_LOGS=1 to see the add-on's structured logs.
if (!process.env.TEST_LOGS) setLogSink(() => {});
