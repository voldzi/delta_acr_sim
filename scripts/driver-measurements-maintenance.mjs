// Runtime DML account only. Invoked inside the SDA image with its pg package.
import {createRequire} from 'node:module';
const require=createRequire('/app/apps/situation-data-api/package.json');
const {Pool}=require('pg');
const p=new Pool({connectionString:process.env.DRIVER_MEASUREMENTS_DATABASE_URL,max:1,connectionTimeoutMillis:1500,statement_timeout:10000});
try{
  const c=await p.connect();
  try{
    await c.query('BEGIN');
    const a=await c.query('DELETE FROM driver_measurement_receipts WHERE expires_at<=now()');
    const b=await c.query('DELETE FROM driver_measurement_revocations WHERE expires_at<=now()');
    await c.query('COMMIT');
    console.log(JSON.stringify({cleanup:'ok',expiredReceipts:a.rowCount,expiredRevocations:b.rowCount}));
  }finally{c.release();}
}catch{console.error('Driver measurement cleanup unavailable');process.exitCode=1;}finally{await p.end();}
