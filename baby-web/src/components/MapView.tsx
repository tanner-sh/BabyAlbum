import { useQuery } from '@tanstack/react-query';
import L from 'leaflet';
import 'leaflet.markercluster';
import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import { MapPin, MapPinOff } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { get, request, thumbUrl, useAlbum, type AlbumItem, type MapData } from '../api';
import { wgs84ToGcj02 } from '../gcj02';
import { Lightbox } from './Lightbox';
import { PhotoGrid } from './PhotoGrid';
import { Empty, ErrorBox, Spinner } from './ui';

// 地图底图：OpenStreetMap 用 GPS 坐标（WGS-84）；高德用国测局坐标（GCJ-02），照片坐标要换算
const TILES = {
  osm: { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '© OpenStreetMap', maxZoom: 19, subdomains: '' },
  amap: {
    url: 'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
    attribution: '© 高德地图',
    maxZoom: 18,
    subdomains: '1234',
  },
};

/** 一次最多看多少张（太多了一页也看不完） */
const MAX_SELECTED = 300;

type Selection = { title: string; ids: string[] };
type AssetMarker = L.Marker & { assetId: string };

/** 聚合点里的第一张照片，用作聚合点的封面（markercluster 没有公开这个方法，直接读内部结构，避免每次都取出全部子节点） */
function firstAssetId(cluster: L.MarkerCluster): string | undefined {
  const c = cluster as unknown as { _markers: AssetMarker[]; _childClusters: L.MarkerCluster[] };
  return c._markers[0]?.assetId ?? (c._childClusters[0] && firstAssetId(c._childClusters[0]));
}

/** 地图：按拍摄地点看照片。babyId 为 null 时看自己能看的全部照片 */
export default function MapView({ babyId }: { babyId: number | null }) {
  const album = useAlbum();
  const data = useQuery({
    queryKey: [album.base, 'map', babyId],
    queryFn: () => get<MapData>(`${album.base}/map${babyId ? `?baby=${babyId}` : ''}`),
    staleTime: 5 * 60_000,
  });
  const [selection, setSelection] = useState<Selection | null>(null);
  const flyTo = useRef<((lat: number, lon: number) => void) | null>(null);

  if (data.isPending) return <Spinner label="正在加载地图…" />;
  if (data.isError) return <ErrorBox error={data.error} />;
  if (!data.data.markers.length) {
    return (
      <Empty icon={<MapPinOff size={40} />} title="还没有带位置的照片">
        手机拍的照片一般都记录了拍摄地点。照片读完拍摄信息后，会陆续出现在地图上。
      </Empty>
    );
  }
  return (
    <>
      <div className="map-layout">
        <MapCanvas data={data.data} onSelect={setSelection} flyTo={flyTo} />
        <aside className="map-places">
          <h3>
            <MapPin size={16} /> 去过的地方
          </h3>
          <ol>
            {data.data.places.map((p) => (
              <li key={`${p.name}-${p.region}`}>
                <button
                  onClick={() => {
                    const ids = nearby(data.data.markers, p.lat, p.lon, 15);
                    setSelection({ title: `${p.name}附近`, ids });
                    flyTo.current?.(p.lat, p.lon);
                  }}
                >
                  <span>
                    {p.name}
                    {p.region && <small className="muted"> {p.region}</small>}
                  </span>
                  <span className="muted">{p.count.toLocaleString()}</span>
                </button>
              </li>
            ))}
          </ol>
        </aside>
      </div>
      <p className="muted small">共 {data.data.markers.length.toLocaleString()} 张带位置的照片。点地图上的照片看这个地方拍的所有照片。</p>
      {selection && <SelectionPanel key={selection.title + selection.ids.length} selection={selection} babyId={babyId} />}
    </>
  );
}

/** 某个点附近 km 公里内的照片 */
function nearby(markers: MapData['markers'], lat: number, lon: number, km: number) {
  const dLat = km / 111;
  const dLon = km / (111 * Math.cos((lat * Math.PI) / 180));
  return markers.filter(([, la, lo]) => Math.abs(la - lat) <= dLat && Math.abs(lo - lon) <= dLon).map(([id]) => id);
}

function MapCanvas({
  data,
  onSelect,
  flyTo,
}: {
  data: MapData;
  onSelect: (s: Selection) => void;
  /** 给地点列表用：飞到某个地方 */
  flyTo: React.RefObject<((lat: number, lon: number) => void) | null>;
}) {
  const album = useAlbum();
  const el = useRef<HTMLDivElement>(null);
  const project = useMemo(() => (data.tiles === 'amap' ? wgs84ToGcj02 : (lat: number, lon: number): [number, number] => [lat, lon]), [data.tiles]);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  useEffect(() => {
    const tiles = TILES[data.tiles];
    const map = L.map(el.current!, { zoomControl: true, worldCopyJump: true });
    L.tileLayer(tiles.url, { attribution: tiles.attribution, maxZoom: tiles.maxZoom, subdomains: tiles.subdomains }).addTo(map);

    const thumb = (id: string | undefined, count?: number) =>
      L.divIcon({
        className: 'map-thumb',
        iconSize: [52, 52],
        html: `${id ? `<img src="${thumbUrl(album, id)}" alt="" loading="lazy">` : ''}${count ? `<span>${count > 999 ? `${Math.floor(count / 1000)}k` : count}</span>` : ''}`,
      });

    const group = L.markerClusterGroup({
      chunkedLoading: true,
      showCoverageOnHover: false,
      maxClusterRadius: 64,
      iconCreateFunction: (cluster) => thumb(firstAssetId(cluster), cluster.getChildCount()),
    });
    const markers = data.markers.map(([id, lat, lon]) => {
      const m = L.marker(project(lat, lon), { icon: thumb(id) }) as AssetMarker;
      m.assetId = id;
      return m;
    });
    group.addLayers(markers);
    group.on('clusterclick', (e) => {
      const ids = (e.propagatedFrom as L.MarkerCluster).getAllChildMarkers().map((m) => (m as AssetMarker).assetId);
      onSelectRef.current({ title: `这里的 ${ids.length.toLocaleString()} 张`, ids });
    });
    group.on('click', (e) => {
      const id = (e.propagatedFrom as AssetMarker).assetId;
      onSelectRef.current({ title: '这张照片', ids: [id] });
    });
    map.addLayer(group);
    map.fitBounds(group.getBounds(), { padding: [24, 24], maxZoom: 14 });

    flyTo.current = (lat, lon) => {
      map.flyTo(project(lat, lon), 12);
      el.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    };
    return () => {
      flyTo.current = null;
      map.remove();
    };
  }, [data, album, project, flyTo]);

  return <div ref={el} className="map-canvas" />;
}

function SelectionPanel({ selection, babyId }: { selection: Selection; babyId: number | null }) {
  const album = useAlbum();
  const ids = selection.ids.slice(0, MAX_SELECTED);
  const items = useQuery({
    queryKey: [album.base, 'map-items', babyId, ids.join(',')],
    queryFn: () => request<AlbumItem[]>('POST', `${album.base}/map/items`, { ids, baby: babyId ?? undefined }),
    staleTime: 5 * 60_000,
  });
  const [open, setOpen] = useState<number | null>(null);
  return (
    <section className="map-selection">
      <header className="group-header">
        <h3>{selection.title}</h3>
        {selection.ids.length > MAX_SELECTED && <span className="muted">先显示其中 {MAX_SELECTED} 张，放大地图可以看得更细</span>}
      </header>
      {items.isPending ? (
        <Spinner />
      ) : items.isError ? (
        <ErrorBox error={items.error} />
      ) : (
        <PhotoGrid items={items.data} onOpen={setOpen} caption={(i) => i.age?.label ?? i.takenAt.slice(0, 10)} />
      )}
      {open !== null && items.data && <Lightbox items={items.data} index={open} onIndexChange={setOpen} onClose={() => setOpen(null)} />}
    </section>
  );
}
