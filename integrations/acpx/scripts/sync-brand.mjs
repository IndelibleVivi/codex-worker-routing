// SPDX-License-Identifier: SUL-1.0
import fs from 'node:fs/promises';
import {renderLogoSVG} from '../src/brand.mjs';
const directory = new URL('../../../plugins/worker-routing/assets/', import.meta.url);
await fs.mkdir(directory, {recursive:true});
await fs.writeFile(new URL('cat.svg', directory), renderLogoSVG());
