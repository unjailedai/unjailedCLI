import { parentPort, workerData } from "node:worker_threads";
import { runSearch, type SearchMessage, type SearchRequest } from "./search.js";

// Runs one glob/grep off the UI thread; tools.ts terminates it on timeout or cancel.
const post = (m: SearchMessage) => parentPort!.postMessage(m);
try {
  runSearch(workerData as SearchRequest, post);
} catch (e) {
  post({ type: "error", message: (e as Error).message });
}
