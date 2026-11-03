/** A framework adapter that installs nothing — see `src/edge/index.ts`. */

import { notice } from "./notice.js";

export function noopAdapter(name: string): {
  name: string;
  install(): Promise<void>;
  uninstall(): void;
} {
  return {
    name,
    install() {
      notice();
      return Promise.resolve();
    },
    uninstall() {},
  };
}
