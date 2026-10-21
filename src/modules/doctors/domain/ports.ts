import type { DiscoveryQuery, DoctorPage } from '../schemas.js';
export interface DirectoryStore {
  generation(): Promise<string>;
  snapshot(query: DiscoveryQuery, now: Date): Promise<{ generation: string; page: DoctorPage }>;
}
export interface DirectoryCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttl: number): Promise<void>;
}
