import {writeFile} from 'node:fs/promises';
import {AUTH_SCHEMA} from './auth.mjs';
import {DIET_SCHEMA} from './diary-store.mjs';
import {FINANCE_SCHEMA_SQL} from './finance.mjs';
import {MARKET_SCHEMA} from './market.mjs';
import {MAIL_SCHEMA} from './mail.mjs';
import {TRAVEL_SCHEMA} from './flights.mjs';
export const schemaSQL=[AUTH_SCHEMA,DIET_SCHEMA,FINANCE_SCHEMA_SQL,...MARKET_SCHEMA,...MAIL_SCHEMA,...TRAVEL_SCHEMA].map(x=>x.trim().replace(/;*$/,'')+';').join('\n');
if(process.argv[2])await writeFile(process.argv[2],schemaSQL);
