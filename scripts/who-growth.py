#!/usr/bin/env python3
"""从 WHO 官网下载 0–5 岁生长标准（Expanded tables，z-scores）的 LMS 参数，生成 baby-web/src/who-growth.ts。
只用 Python 标准库。用法：python3 scripts/who-growth.py"""
import io, json, os, urllib.request, zipfile, xml.etree.ElementTree as ET

BASE = 'https://cdn.who.int/media/docs/default-source/child-growth/child-growth-standards/indicators'
TABLES = {
    'weight': 'weight-for-age/expanded-tables/wfa-{sex}-zscore-expanded-tables.xlsx',
    'length': 'length-height-for-age/expandable-tables/lhfa-{sex}-zscore-expanded-tables.xlsx',
    'head': 'head-circumference-for-age/expanded-tables/hcfa-{sex}-zscore-expanded-tables.xlsx',
}
NS = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
OUT = os.path.join(os.path.dirname(__file__), '..', 'baby-web', 'src', 'who-growth.ts')


def rows(data: bytes):
    z = zipfile.ZipFile(io.BytesIO(data))
    strings = []
    if 'xl/sharedStrings.xml' in z.namelist():
        for si in ET.fromstring(z.read('xl/sharedStrings.xml')).findall('m:si', NS):
            strings.append(''.join(t.text or '' for t in si.iter('{%s}t' % NS['m'])))
    sheet = sorted(n for n in z.namelist() if n.startswith('xl/worksheets/sheet'))[0]
    for r in ET.fromstring(z.read(sheet)).iter('{%s}row' % NS['m']):
        values = []
        for c in r.findall('m:c', NS):
            v = c.find('m:v', NS)
            values.append(None if v is None else strings[int(v.text)] if c.get('t') == 's' else v.text)
        yield values


def table(path: str):
    # WHO 的 CDN 会拒绝 Python 默认的 User-Agent
    req = urllib.request.Request(f'{BASE}/{path}', headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=60) as res:
        data = res.read()
    it = rows(data)
    header = next(it)
    assert header[:4] == ['Day', 'L', 'M', 'S'], header
    points = []
    for row in it:
        day = int(float(row[0]))
        # 每 7 天取一个点，前端按天线性插值，误差远小于测量误差
        if day % 7 == 0 or day == 1856:
            points.append([day, round(float(row[1]), 4), round(float(row[2]), 4), round(float(row[3]), 5)])
    return points


lines = [
    '// WHO 儿童生长标准（WHO Child Growth Standards, 2006）0–5 岁的 LMS 参数，每 7 天一个点，中间按天线性插值。',
    '// 数据来源：https://www.who.int/tools/child-growth-standards/standards（Expanded tables，z-scores）',
    '// 由 scripts/who-growth.py 从 WHO 官方表格生成，不要手动修改。每行：[出生后天数, L, M, S]',
    '',
    'export type LmsRow = [day: number, L: number, M: number, S: number];',
    "export type Sex = 'boy' | 'girl';",
    "export type Indicator = 'weight' | 'length' | 'head';",
    '',
    'export const WHO_LMS: Record<Indicator, Record<Sex, LmsRow[]>> = {',
]
for key, path in TABLES.items():
    lines.append(f'  {key}: {{')
    for sex, name in [('boy', 'boys'), ('girl', 'girls')]:
        lines.append(f'    {sex}: {json.dumps(table(path.format(sex=name)), separators=(",", ":"))},')
    lines.append('  },')
lines.append('};')
with open(OUT, 'w') as f:
    f.write('\n'.join(lines) + '\n')
print('已生成', os.path.normpath(OUT))
