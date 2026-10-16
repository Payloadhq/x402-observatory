'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { inspectChallenge, checkCompleteness } = require('../scanner/validate.js');

function inspect(json) {
  const ch=inspectChallenge({status:402,headers:{'content-type':'application/json'},body:JSON.stringify(json)});
  assert.ok(ch && !ch.malformed);
  return {version:ch.version,...checkCompleteness(ch.challenge,ch.version)};
}
test('x402 v1 base slug challenge is payment-valid, not INCOMPLETE_CHALLENGE',()=>{
 const x=inspect({x402Version:1,accepts:[{scheme:'exact',network:'base',asset:'0xUSDC',maxAmountRequired:'100',payTo:'0xpayee'}]});
 assert.equal(x.version,1);assert.equal(x.complete,true);assert.equal(x.knownNetwork,true);assert.equal(x.formatDrift,false);
});
test('x402 v1 solana legacy slug is recognized',()=>{
 const x=inspect({x402Version:1,accepts:[{scheme:'exact',network:'solana',asset:'SoL',maxAmountRequired:'100',payTo:'recipient'}]});
 assert.equal(x.version,1);assert.equal(x.complete,true);assert.equal(x.knownNetwork,true);
});
test('CAIP-2 v2 challenge is valid without warning',()=>{
 const x=inspect({x402Version:2,accepts:[{scheme:'exact',network:'eip155:8453',asset:'USDC',amount:'100',payTo:'0xpayee'}]});
 assert.equal(x.version,2);assert.equal(x.complete,true);assert.equal(x.knownNetwork,true);assert.equal(x.formatDrift,false);
});
test('v2 legacy slug is compatibility drift, NOT broken endpoint',()=>{
 const x=inspect({x402Version:2,accepts:[{scheme:'exact',network:'base',asset:'USDC',amount:'100',payTo:'0xpayee'}]});
 assert.equal(x.complete,true);assert.equal(x.knownNetwork,true);assert.equal(x.formatDrift,true);
});
test('malformed or unknown networks remain non-valid',()=>{
 for(const network of ['???','test-chain','','javascript:foo']){
  const x=inspect({x402Version:2,accepts:[{network,asset:'USDC',amount:'100'}]});
  assert.equal(x.knownNetwork,false);
 }
});
test('402 without valid challenge remains malformed',()=>{
 const x=inspectChallenge({status:402,headers:{},body:'please pay'});
 assert.deepEqual(x,{malformed:true});
});