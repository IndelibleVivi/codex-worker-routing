// SPDX-License-Identifier: SUL-1.0
// Small local display preferences; no route, runtime or business-data writes.
import path from 'node:path';
import {THEMES} from './themes.mjs';
import {Fault,readJSON,atomicJSON} from './state.mjs';

export const defaultPreferences = () => ({theme:'sage',language:'zh',timeZone:'local'});
export function validatePreferences(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['theme','language','timeZone'].includes(key)) ||
      !THEMES.some(theme => theme.id === value.theme) || !['zh','en'].includes(value.language) ||
      typeof value.timeZone !== 'string' || value.timeZone.length > 100)
    throw new Fault('BAD_PREFERENCES','Only theme, language and timeZone are supported.');
  if (value.timeZone !== 'local') {
    try { new Intl.DateTimeFormat('en',{timeZone:value.timeZone}).format(0); }
    catch { throw new Fault('BAD_PREFERENCES','Use a valid IANA time zone or local.'); }
  }
  return {theme:value.theme,language:value.language,timeZone:value.timeZone};
}
export async function readPreferences(stateDir) {
  if (!stateDir) return defaultPreferences();
  try { return validatePreferences(await readJSON(path.join(stateDir,'dashboard-preferences.json'),{privateFile:true})); }
  catch (error) { if (error.code === 'ENOENT') return defaultPreferences(); throw error; }
}
export async function writePreferences(stateDir,value) {
  const next=validatePreferences(value);
  if (!stateDir) throw new Fault('PREFERENCES_UNAVAILABLE','No local preference store is configured.');
  await atomicJSON(path.join(stateDir,'dashboard-preferences.json'),next);
  return next;
}
