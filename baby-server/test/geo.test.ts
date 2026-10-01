import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cityZh, countryZh, placeZh, stateZh } from '../src/geo.ts';

const CN = "People's Republic of China";

test('国家用中文', () => {
  assert.equal(countryZh(CN), '中国');
  assert.equal(countryZh('Japan'), '日本');
  assert.equal(countryZh('United States of America'), '美国');
  // 不认识的保留原文
  assert.equal(countryZh('Atlantis'), 'Atlantis');
  assert.equal(countryZh(null), null);
});

test('中国的省份用简短的说法，其他国家用 GeoNames 的中文名', () => {
  assert.equal(stateZh('Shanghai', CN), '上海');
  assert.equal(stateZh('Inner Mongolia', CN), '内蒙古');
  assert.equal(stateZh('Tokyo', 'Japan'), '东京都');
  assert.equal(stateZh('Nowhere', 'Japan'), 'Nowhere');
});

test('同名的地方按坐标区分', () => {
  // 上海的黄浦、广州的黄埔、中山的黄圃，英文都是 Huangpu
  assert.equal(cityZh('Huangpu', CN, 31.233, 121.473), '黄浦');
  assert.equal(cityZh('Huangpu', CN, 23.1, 113.45), '黄埔');
  assert.equal(cityZh('Huangpu', CN, 22.72, 113.34), '黄圃');
});

test('没有标注语言的中文名时，用别名里的汉字（取最短的）', () => {
  // 上海金山的山阳镇：GeoNames 的多语言表里没有它的中文名，别名里有“山阳,山阳镇”
  assert.equal(cityZh('Shanyang', CN, 30.77, 121.36), '山阳');
});

test('坐标离得太远的不认为是同一个地方，保留原文', () => {
  // 名字叫 Shanyang，但在新疆，附近没有叫这个名字的地方
  assert.equal(cityZh('Shanyang', CN, 43.8, 87.6), 'Shanyang');
  assert.equal(cityZh('Hatchōbori', 'Japan', 35.68, 139.77), 'Hatchōbori');
});

test('placeZh 一起翻译', () => {
  assert.deepEqual(placeZh({ city: 'Songbei', state: 'Heilongjiang', country: CN, latitude: 45.8, longitude: 126.53 }), { city: '松北', state: '黑龙江', country: '中国' });
});
