#!/usr/bin/env python3
"""从 GeoNames 下载城市、一级行政区（省、州）的中文名，生成 baby-server/src/geo-zh.json。
Immich 的反向地理编码用的也是 GeoNames 的 cities500 和 admin1CodesASCII，地名的英文写法一致，可以直接对照。
GeoNames 数据使用 CC BY 4.0 许可证：https://www.geonames.org/
只用 Python 标准库。用法：python3 scripts/geo-names.py（要下载约 220 MB）"""
import csv, io, json, os, sys, urllib.request, zipfile

BASE = 'https://download.geonames.org/export/dump'
OUT = os.path.join(os.path.dirname(__file__), '..', 'baby-server', 'src', 'geo-zh.json')
CACHE = os.environ.get('GEONAMES_CACHE', '/tmp/geonames')
# 简体优先，其次是不区分简繁的 zh
LANG_RANK = {'zh-CN': 0, 'zh-Hans': 0, 'zh-SG': 1, 'zh': 2}

csv.field_size_limit(sys.maxsize)


def download(name):
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, name)
    if not os.path.exists(path):
        print('下载', name, file=sys.stderr)
        req = urllib.request.Request(f'{BASE}/{name}', headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=600) as res, open(path + '.part', 'wb') as f:
            while chunk := res.read(1 << 20):
                f.write(chunk)
        os.rename(path + '.part', path)
    return path


def rows(path, member=None):
    if member:
        with zipfile.ZipFile(path) as z, z.open(member) as f:
            yield from csv.reader(io.TextIOWrapper(f, encoding='utf-8'), delimiter='\t', quoting=csv.QUOTE_NONE)
    else:
        with open(path, encoding='utf-8') as f:
            yield from csv.reader(f, delimiter='\t', quoting=csv.QUOTE_NONE)


# 城市：geonameid → (名字, 纬度, 经度, 国家代码)
cities = {}
# 中国（含港澳台）的小地方常常没有标注语言的中文名，但 cities500 自带的别名里有汉字写法（“山阳,山阳镇”），
# 挑纯汉字的最短一个作为兜底（去掉“镇”“乡”这类后缀的那个）。日本等地的汉字写法和中文不一定相同，不用兜底
CJK_COUNTRIES = {'CN', 'TW', 'HK', 'MO'}
fallback = {}
is_cjk = lambda s: s and all('\u4e00' <= ch <= '\u9fff' for ch in s)
for r in rows(download('cities500.zip'), 'cities500.txt'):
    cities[r[0]] = (r[1], round(float(r[4]), 3), round(float(r[5]), 3), r[8])
    if r[8] in CJK_COUNTRIES:
        names = sorted((n for n in r[3].split(',') if is_cjk(n)), key=len)
        if names:
            fallback[r[0]] = names[0]

# 一级行政区：geonameid → (国家代码, 名字)
admin1 = {}
for r in rows(download('admin1CodesASCII.txt')):
    admin1[r[3]] = (r[0].split('.')[0], r[1])

# 中文名：每个地方挑一个（简体优先，优先“首选名”，不要旧称、口语）
best = {}
for r in rows(download('alternateNamesV2.zip'), 'alternateNamesV2.txt'):
    gid, lang, name = r[1], r[2], r[3]
    if lang not in LANG_RANK or (gid not in cities and gid not in admin1):
        continue
    preferred, short, colloquial, historic = (r[i] == '1' if len(r) > i else False for i in (4, 5, 6, 7))
    if colloquial or historic:
        continue
    rank = (LANG_RANK[lang], 0 if preferred else 1, 1 if short else 0)
    if gid not in best or rank < best[gid][0]:
        best[gid] = (rank, name)

out_cities = {}
for gid, (name, lat, lon, cc) in cities.items():
    zh = best[gid][1] if gid in best else fallback.get(gid)
    if zh:
        out_cities.setdefault(name, []).append([lat, lon, cc, zh])
out_admin1 = {f'{cc}|{name}': best[gid][1] for gid, (cc, name) in admin1.items() if gid in best}

with open(OUT, 'w', encoding='utf-8') as f:
    json.dump({'source': 'GeoNames (CC BY 4.0) https://www.geonames.org/', 'cities': out_cities, 'admin1': out_admin1}, f, ensure_ascii=False, separators=(',', ':'))
print(f'已生成 {os.path.normpath(OUT)}：城市 {sum(len(v) for v in out_cities.values())} 个，一级行政区 {len(out_admin1)} 个', file=sys.stderr)
