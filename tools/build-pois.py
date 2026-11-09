#!/usr/bin/env python3
"""从 OpenStreetMap (Overpass) 生成预置山区的离线地点包 data/pois.json。
用法：python3 tools/build-pois.py
"""
import json, re, subprocess, time, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
spots = re.findall(r"id: '(\w+)', name: '([^']+)', lat: ([\d.-]+), lon: ([\d.-]+)", (ROOT / 'js/spots.js').read_text())
WIDE = {'wugong': (27.30, 113.92, 27.62, 114.42)}  # 武功山全域（含羊狮慕、发云界、九龙山、沈子村、龙山村）
R = 0.14

KIND = [
    ('tourism', {'alpine_hut': '客栈/山屋', 'guest_house': '客栈', 'hotel': '酒店', 'hostel': '青旅', 'chalet': '客栈',
                 'motel': '酒店', 'camp_site': '营地', 'viewpoint': '观景台', 'attraction': '景点', 'information': '指示/信息',
                 'picnic_site': '休息点', 'wilderness_hut': '山屋', 'museum': '景点'}),
    ('natural', {'peak': '山峰', 'saddle': '垭口', 'cliff': '崖', 'spring': '泉', 'water': '水体', 'rock': '奇石',
                 'ridge': '山脊', 'cave_entrance': '洞', 'valley': '山谷', 'waterfall': '瀑布'}),
    ('waterway', {'waterfall': '瀑布'}),
    ('aerialway', {'station': '索道站', 'cable_car': '索道', 'gondola': '索道', 'chair_lift': '索道'}),
    ('amenity', {'restaurant': '餐饮', 'cafe': '餐饮', 'fast_food': '餐饮', 'parking': '停车场', 'place_of_worship': '寺庙',
                 'toilets': '厕所', 'ranger_station': '管理站', 'shelter': '避难所', 'bus_station': '车站', 'drinking_water': '饮水'}),
    ('highway', {'trailhead': '登山口', 'bus_stop': '车站'}),
    ('historic', None), ('shop', None), ('leisure', None),
    ('place', {'town': '镇', 'village': '村', 'hamlet': '村', 'locality': '地名', 'isolated_dwelling': '地名', 'neighbourhood': '地名'}),
]
SKIP_HW = True

def kind_of(t):
    for k, m in KIND:
        if k in t:
            if m is None:
                return {'historic': '古迹', 'shop': '商店', 'leisure': '休闲'}[k]
            if t[k] in m:
                return m[t[k]]
    return None

def query(bbox):
    s, w, n, e = bbox
    q = f'[out:json][timeout:90];nwr["name"]({s},{w},{n},{e});out center tags;'
    for attempt in range(3):
        r = subprocess.run(['curl', '-sf', '--max-time', '120', '-A', 'cloudsea-sunrise-poi-builder/1.0',
                            'https://overpass-api.de/api/interpreter', '--data-urlencode', f'data={q}'], capture_output=True, text=True)
        if r.returncode == 0:
            return json.loads(r.stdout)['elements']
        time.sleep(10)
    raise RuntimeError(f'Overpass 请求失败: {bbox}')

out = {}
for sid, name, lat, lon in spots:
    lat, lon = float(lat), float(lon)
    bbox = WIDE.get(sid, (lat - R, lon - R, lat + R, lon + R))
    rows, seen = [], set()
    for el in query(bbox):
        t = el.get('tags', {})
        k = kind_of(t)
        if not k:
            continue
        c = el.get('center') or el
        if 'lat' not in c:
            continue
        nm = t.get('name:zh') or t['name']
        key = (nm, round(c['lat'], 3), round(c['lon'], 3))
        if key in seen:
            continue
        seen.add(key)
        ele = re.match(r'^\s*(\d{2,4}(?:\.\d+)?)', t.get('ele', ''))
        rows.append([nm, round(c['lat'], 5), round(c['lon'], 5), k, round(float(ele.group(1))) if ele else None])
    out[sid] = {'name': name, 'bbox': bbox, 'pois': rows}
    print(sid, name, len(rows))
    time.sleep(2)

(ROOT / 'data/pois.json').write_text(json.dumps(out, ensure_ascii=False, separators=(',', ':')))
print('wrote data/pois.json', (ROOT / 'data/pois.json').stat().st_size, 'bytes')
