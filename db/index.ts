import { getEnv } from "../lib/database";

export function getDb() {
  return getEnv().DB;
}
