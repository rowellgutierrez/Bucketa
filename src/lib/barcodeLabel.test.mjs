import test from 'node:test';
import assert from 'node:assert/strict';
import JsBarcode from 'jsbarcode';
test('installed JsBarcode encodes valid internal Code 128 and commercial EAN/UPC',()=>{
 for(const [format,value] of [['CODE128','BKT-ABCDEFG234'],['EAN13','4006381333931'],['UPC','036000291452'],['EAN8','96385074']]) {
 const Encoder=JsBarcode.getModule(format);const encoder=new Encoder(value,{});
 assert.equal(encoder.valid(),true);const encoded=encoder.encode();const bits=(Array.isArray(encoded)?encoded:[encoded]).map(part=>part.data).join('');assert.match(bits,/^[01]+$/);assert.ok(bits.length>50);
 }
 const Invalid=JsBarcode.getModule('EAN13');assert.equal(new Invalid('4006381333932',{}).valid(),false);
});
