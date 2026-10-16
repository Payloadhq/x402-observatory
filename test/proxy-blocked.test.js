'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {proxyConnectBlocked}=require('../scanner/connect-errors');
test('proxy CONNECT 403 is unmeasured infrastructure refusal',()=>{
 assert.equal(proxyConnectBlocked('tunneling socket could not be established, statusCode=403'),true);
 assert.equal(proxyConnectBlocked('proxy CONNECT rejected: 403 Forbidden'),true);
});
test('remote HTTP statuses and unrelated failures are not proxy blocks',()=>{
 for(const s of ['HTTP 403 returned by origin','connect ECONNREFUSED','socket hang up','DNS timeout','404','endpoint HTTP 402'])
   assert.equal(proxyConnectBlocked(s),false,s);
});
