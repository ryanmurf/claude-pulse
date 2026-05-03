import { Profile } from "./types.js";

export function redactProfile(
  p: Profile
): Omit<Profile, "api_key"> & { api_key: string | null } {
  return { ...p, api_key: p.api_key ? "***" : null };
}
