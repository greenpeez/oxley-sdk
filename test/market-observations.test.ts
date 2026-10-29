import assert from "node:assert/strict";
import test from "node:test";
import {validMarketCapitalization,validMarketObservationFields,validMarketProtocolObservation} from "../src/market-observations.js";
const address=`0x${"12".repeat(20)}`,hash=`0x${"34".repeat(32)}`;
const identity={chainId:99801,generation:"gen5-test",dealId:hash,coin:address,curve:address,quoteAsset:address,
  blockNumber:"10",blockHash:hash,blockTimestamp:100,checkedAt:100};
const cap={...identity,definition:"outside-curve-v1",spotPriceWad:String(10n**24n),totalSupplyUnits:String(1000n*10n**18n),
  curveBalanceUnits:String(900n*10n**18n),outsideCurveSupplyUnits:String(100n*10n**18n),marketCapQuoteUnits:"100000000"};
test("market capitalization validates actual outside supply exact zero and derived values above uint256",()=>{
  assert.equal(validMarketCapitalization(cap),true);
  assert.equal(validMarketCapitalization({...cap,curveBalanceUnits:cap.totalSupplyUnits,outsideCurveSupplyUnits:"0",marketCapQuoteUnits:"0"}),true);
  const max=(1n<<256n)-1n;
  assert.equal(validMarketCapitalization({...cap,spotPriceWad:String(max),totalSupplyUnits:String(max),curveBalanceUnits:"0",
    outsideCurveSupplyUnits:String(max),marketCapQuoteUnits:String(max*max/10n**36n)}),true);
  assert.equal(validMarketCapitalization({...cap,curveBalanceUnits:String(1001n*10n**18n)}),false);
  assert.equal(validMarketCapitalization({...cap,marketCapQuoteUnits:"100000001"}),false);
});
test("optional market observations preserve old responses and reject mismatched identities",()=>{
  assert.equal(validMarketObservationFields(identity),true);
  assert.equal(validMarketObservationFields({...identity,capitalization:null,protocolObservation:null}),true);
  assert.equal(validMarketObservationFields({...identity,capitalization:cap}),true);
  assert.equal(validMarketObservationFields({...identity,capitalization:{...cap,coin:`0x${"56".repeat(20)}`}}),false);
});
test("protocol observations distinguish unknown status and require typed locks canonical progress and valid vault addresses",()=>{
  const status={...identity,feeRouter:address,listing:null,creatorRewardLock:null};
  assert.equal(validMarketProtocolObservation(status),true);
  assert.equal(validMarketProtocolObservation({...status,creatorRewardLock:{durationDays:"30",activated:true,unlockAt:500}}),false);
  assert.equal(validMarketProtocolObservation({...status,asOf:{blockNumber:"9",blockHash:hash,timestamp:101}}),false);
  assert.equal(validMarketProtocolObservation({...status,listing:{address:12,configured:false,purchased:false,activatedAt:0,expiresAt:0,commitmentBps:0}}),false);
});
