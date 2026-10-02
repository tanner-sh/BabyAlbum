import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { createContext, useContext } from 'react';

// ---------------------------------------------------------------- 类型（与 baby-server 的返回值对应）

export type Sex = 'boy' | 'girl';
export type Baby = {
  id: number;
  name: string;
  birthday: string;
  immichPersonId: string;
  /** 用于和 WHO 生长标准对比，没填时为 null */
  sex: Sex | null;
  ageLabel: string;
  thumbnailUrl: string;
};

export type AlbumItem = {
  id: string;
  type: 'IMAGE' | 'VIDEO' | 'AUDIO' | 'OTHER';
  takenAt: string;
  fileName: string;
  /** 毫秒 */
  duration: number | null;
  isFavorite: boolean;
  width: number | null;
  height: number | null;
  /** 实况照片的视频部分 */
  livePhotoVideoId: string | null;
  /** 宝宝在这张照片里的年龄；“全部照片”里没有 */
  age?: { label: string; days: number; months: number };
};

export type TimelineGroup = { label: string; months: number; items: AlbumItem[] };
export type TimelinePage = { page: number; nextPage: number | null; groups: TimelineGroup[] };
export type OnThisDayEntry = { year: number; yearsAgo: number; date: string; ageLabel: string; items: AlbumItem[] };
export type GrowthCell = { months: number; label: string; from: string; cover: AlbumItem | null };
export type MonthItems = { months: number; from: string; to: string; items: AlbumItem[] };
export type Milestone = {
  id: number;
  babyId: number;
  title: string;
  date: string;
  note: string;
  coverAssetId: string | null;
  ageLabel: string;
};
export type AssetInfo = {
  id: string;
  type: AlbumItem['type'];
  takenAt: string;
  /** 日期在宝宝相册里被更正过时，这里是原始日期 */
  originalTakenAt: string | null;
  fileName: string;
  isFavorite: boolean;
  duration: number | null;
  width: number | null;
  height: number | null;
  fileSize: number | null;
  camera: string | null;
  place: string | null;
  babies: { id: number; name: string; ageLabel: string }[];
};
export type Role = 'admin' | 'member' | 'viewer';
export type Share = {
  id: number;
  token: string;
  label: string;
  babyIds: number[];
  /** 分享的是一个相册 */
  albumId: number | null;
  allowComments: boolean;
  expiresAt: string | null;
  createdAt: string;
  hasPassword: boolean;
  allowDownload: boolean;
  elderMode: boolean;
};
export type ShareInfo =
  | { needsPassword: true }
  | {
      needsPassword: false;
      label: string;
      expiresAt: string | null;
      allowDownload: boolean;
      elderMode: boolean;
      allowComments: boolean;
      album: { id: number; title: string; description: string } | null;
      babies: Baby[];
    };
export type Measurement = {
  id: number;
  babyId: number;
  date: string;
  heightCm: number | null;
  weightKg: number | null;
  headCm: number | null;
  note: string;
  ageLabel: string;
  ageDays: number;
};
export type JournalEntry = {
  id: number;
  babyId: number;
  date: string;
  text: string;
  authorId: number | null;
  authorName: string | null;
  ageLabel: string;
  createdAt: string;
  updatedAt: string;
};
export type ReviewKind = 'month' | 'year';
export type Review = {
  kind: ReviewKind;
  index: number;
  label: string;
  from: string;
  to: string;
  total: number;
  videos: number;
  favorites: number;
  items: AlbumItem[];
};
export type SearchPage = { page: number; nextPage: number | null; items: AlbumItem[] };
export type DateIssueGroup = { folder: string; suggestedDate: string | null; items: AlbumItem[] };
export type Me = { id: number; username: string; displayName: string; role: Role; babyIds: number[] | null };

// ---------------------------------------------------------------- 请求

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.message ?? `请求失败（${res.status}）`);
  return data as T;
}

export const get = <T>(url: string) => request<T>('GET', url);

// ---------------------------------------------------------------- 相册上下文
// 登录用户：base = /api；分享链接访客：base = /api/share/<token>，只读

/**
 * 当前浏览的上下文：base 是接口前缀（登录用户 /api，分享链接 /api/share/<token>）；
 * readOnly：不能编辑；interact：能不能点赞留言（分享链接里还带着访客的默认称呼）
 */
export type Album = { base: string; readOnly: boolean; allowDownload: boolean; interact: false | { visitorName?: string } };
export const AlbumContext = createContext<Album>({ base: '/api', readOnly: false, allowDownload: true, interact: {} });
export const useAlbum = () => useContext(AlbumContext);

export const thumbUrl = (album: Album, id: string, size: 'thumbnail' | 'preview' = 'thumbnail') =>
  `${album.base}/assets/${id}/thumbnail${size === 'preview' ? '?size=preview' : ''}`;
export const videoUrl = (album: Album, id: string) => `${album.base}/assets/${id}/video`;
export const originalUrl = (album: Album, id: string) => `${album.base}/assets/${id}/original`;
/** 实况照片的视频：传照片的 ID */
export const liveUrl = (album: Album, id: string) => `${album.base}/assets/${id}/live`;

// ---------------------------------------------------------------- 查询

/** withWho：只看和某个家人（人物 ID）的合照，或者 'family'（全家福） */
export function useTimeline(babyId: number, withWho: string | null = null) {
  const album = useAlbum();
  return useInfiniteQuery({
    queryKey: [album.base, 'timeline', babyId, withWho],
    queryFn: ({ pageParam }) =>
      get<TimelinePage>(`${album.base}/babies/${babyId}/timeline?page=${pageParam}&size=120${withWho ? `&with=${withWho}` : ''}`),
    initialPageParam: 1,
    getNextPageParam: (last) => last.nextPage,
  });
}

export function useOnThisDay(babyId: number) {
  const album = useAlbum();
  return useQuery({
    queryKey: [album.base, 'on-this-day', babyId],
    queryFn: () => get<OnThisDayEntry[]>(`${album.base}/babies/${babyId}/on-this-day`),
  });
}

export function useGrowth(babyId: number) {
  const album = useAlbum();
  return useQuery({
    queryKey: [album.base, 'growth', babyId],
    queryFn: () => get<GrowthCell[]>(`${album.base}/babies/${babyId}/growth`),
  });
}

export function useMonth(babyId: number, months: number | null) {
  const album = useAlbum();
  return useQuery({
    queryKey: [album.base, 'month', babyId, months],
    queryFn: () => get<MonthItems>(`${album.base}/babies/${babyId}/months/${months}`),
    enabled: months !== null && months >= 0,
  });
}

export function useMilestones(babyId: number) {
  const album = useAlbum();
  return useQuery({
    queryKey: [album.base, 'milestones', babyId],
    queryFn: () => get<Milestone[]>(`${album.base}/babies/${babyId}/milestones`),
  });
}

export function useMeasurements(babyId: number) {
  const album = useAlbum();
  return useQuery({
    queryKey: [album.base, 'measurements', babyId],
    queryFn: () => get<Measurement[]>(`${album.base}/babies/${babyId}/measurements`),
  });
}

export function useJournal(babyId: number) {
  const album = useAlbum();
  return useQuery({
    queryKey: [album.base, 'journal', babyId],
    queryFn: () => get<JournalEntry[]>(`${album.base}/babies/${babyId}/journal`),
  });
}

export function useDay(babyId: number, date: string | null) {
  const album = useAlbum();
  return useQuery({
    queryKey: [album.base, 'day', babyId, date],
    queryFn: () => get<AlbumItem[]>(`${album.base}/babies/${babyId}/days/${date}`),
    enabled: !!date,
    staleTime: 10 * 60_000,
  });
}

export function useReview(babyId: number, kind: ReviewKind, index: number | null) {
  const album = useAlbum();
  return useQuery({
    queryKey: [album.base, 'review', babyId, kind, index],
    queryFn: () => get<Review>(`${album.base}/babies/${babyId}/review?kind=${kind}&index=${index}`),
    enabled: index !== null && index >= 0,
    staleTime: 30 * 60_000,
  });
}

export function useSearch(q: string, babyId: number | null) {
  const album = useAlbum();
  return useInfiniteQuery({
    queryKey: [album.base, 'search', q, babyId],
    queryFn: ({ pageParam }) =>
      get<SearchPage>(`${album.base}/search?q=${encodeURIComponent(q)}&page=${pageParam}${babyId ? `&baby=${babyId}` : ''}`),
    initialPageParam: 1,
    getNextPageParam: (last) => last.nextPage,
    enabled: !!q.trim(),
    staleTime: 10 * 60_000,
  });
}

export function useAssetInfo(id: string | null) {
  const album = useAlbum();
  return useQuery({
    queryKey: [album.base, 'asset', id],
    queryFn: () => get<AssetInfo>(`${album.base}/assets/${id}`),
    enabled: !!id,
  });
}

/** enabled：分享链接里没登录，不去请求 */
export function useBabies(enabled = true) {
  return useQuery({ queryKey: ['babies'], queryFn: () => get<Baby[]>('/api/babies'), enabled });
}

export function useMe() {
  return useQuery({ queryKey: ['me'], queryFn: () => get<Me>('/api/auth/me'), retry: false });
}

export function useDateIssues(babyId: number) {
  return useQuery({
    queryKey: ['date-issues', babyId],
    queryFn: () => get<DateIssueGroup[]>(`/api/babies/${babyId}/date-issues`),
    staleTime: 10 * 60_000,
  });
}

export const ROLE_LABELS: Record<Role, string> = { admin: '管理员', member: '家人', viewer: '只读' };
export const ROLE_HINTS: Record<Role, string> = {
  admin: '全部功能，包括成员管理和照片库设置',
  member: '浏览、收藏、记里程碑、更正日期、分享给亲友',
  viewer: '只能浏览',
};

export type ImmichState = 'connecting' | 'unreachable' | 'needs_credentials' | 'connected';
export type SetupStatus = { needsSetup: boolean; immich: { state: ImmichState; error: string | null } };

export function useSetupStatus() {
  return useQuery({ queryKey: ['setup'], queryFn: () => get<SetupStatus>('/api/setup'), retry: false });
}

/** 当前用户能否修改内容（收藏、里程碑、日期更正、分享） */
export const canEdit = (me: Me | undefined) => me?.role === 'admin' || me?.role === 'member';

/** 能否看“全部照片”（包括没有宝宝的）：管理员，以及能看所有宝宝的家人 */
export const canSeeAllPhotos = (me: Me | undefined) => me?.role === 'admin' || (me?.role === 'member' && me.babyIds === null);

export type PhotosPage = { page: number; nextPage: number | null; groups: { label: string; items: AlbumItem[] }[] };

export function usePhotos() {
  return useInfiniteQuery({
    queryKey: ['/api', 'photos'],
    queryFn: ({ pageParam }) => get<PhotosPage>(`/api/photos?page=${pageParam}&size=150`),
    initialPageParam: 1,
    getNextPageParam: (last) => last.nextPage,
  });
}

// ---------------------------------------------------------------- 管理后台

export type AdminUser = Me & { disabled: boolean; createdAt: string; lastLoginAt: string | null };
export type AdminInvite = {
  token: string;
  role: Role;
  babyIds: number[] | null;
  note: string;
  expiresAt: string;
  usedBy: number | null;
  usedByName: string | null;
  expired: boolean;
};
export type Queue = { name: string; label: string; isPaused: boolean; active: number; waiting: number; delayed: number; failed: number; completed: number };
export type Library = { id: string; name: string; importPaths: string[]; exclusionPatterns: string[]; assetCount: number; usage: number; refreshedAt: string | null };
export type ImmichOverview = {
  status: { state: ImmichState; error: string | null };
  nasRoot: string;
  version?: string;
  serviceAccount?: string | null;
  /** counting：还在读取文件信息，原始文件总大小还不完整 */
  stats?: { photos: number; videos: number; usage: number; counting: boolean };
  /** 都是字节。immichData：Immich 自己的缩略图等（后台定期统计，刚启动时可能还没有） */
  storage?: { immichData: number | null; diskUsed: number; diskSize: number; diskAvailable: number };
  queues?: Queue[];
  libraries?: Library[];
};
export type FolderListing = { path: string; relative: string; folders: { name: string; label: string; path: string }[] };
export type MountStatus = { state: 'ok' | 'error' | 'pending'; error: string | null; checkedAt: string | null };
export type StorageProtocol = 'smb' | 'nfs' | 'webdav';
export type NasSource = {
  id: number;
  name: string;
  protocol: StorageProtocol;
  host: string;
  share: string;
  url: string;
  subPath: string;
  username: string;
  vers: string;
  mountPath: string;
  status: MountStatus;
  libraries: string[];
};
export type NasOverview = { mounter: boolean; sources: NasSource[]; backup: { sourceId: number; subPath: string; status: MountStatus } | null };
export type AdminPerson = {
  id: string;
  name: string;
  birthDate: string | null;
  isHidden: boolean;
  assets: number;
  baby: { id: number; name: string } | null;
  thumbnailUrl: string;
};
export type ImmichSettings = {
  transcode: 'disabled' | 'required' | 'optimal' | 'all';
  targetResolution: string;
  machineLearning: boolean;
  facialRecognition: boolean;
  smartSearch: boolean;
  clipModel: string;
  duplicateDetection: boolean;
  ocr: boolean;
  minFaces: number;
  concurrency: Record<'library' | 'metadataExtraction' | 'thumbnailGeneration' | 'faceDetection' | 'smartSearch' | 'videoConversion', number>;
  libraryScan: { enabled: boolean; cronExpression: string };
  backup: { enabled: boolean; cronExpression: string; keepLastAmount: number };
  reverseGeocoding: boolean;
  trashDays: number;
};

export type StageProgress = { name: string; label: string; remaining: number; ratePerHour: number | null; etaHours: number | null };
/** queued：在排队，暂时没在处理（Immich 正在处理另一类） */
export type TypeProgress = { total: number; pending: number; ratePerHour: number | null; etaHours: number | null; queued: boolean };
export type ImportProgress = {
  importing: boolean;
  sampledMinutes: number;
  stages: StageProgress[];
  photos: TypeProgress | null;
  videos: TypeProgress | null;
  countedAt: string | null;
  counting: boolean;
};
export type PersonSuggestion = { id: string; assets: number; thumbnailUrl: string } | null;
export type SimilarPerson = { id: string; name: string; assets: number; together: number; thumbnailUrl: string };
/** 人物在一张照片里的脸：box 是相对整张照片的比例，ratio 是照片宽高比 */
export type PersonFace = AlbumItem & { box: { x: number; y: number; w: number; h: number; ratio: number } | null };
export type DuplicateAsset = {
  id: string;
  type: AlbumItem['type'];
  fileName: string;
  path: string;
  takenAt: string;
  width: number | null;
  height: number | null;
  fileSize: number | null;
  isFavorite: boolean;
  hidden: boolean;
};
export type DuplicateGroup = { id: string; suggestedKeep: string[]; assets: DuplicateAsset[] };
export type HiddenAsset = { assetId: string; reason: string; createdAt: string; fileName: string | null; path: string | null; takenAt: string | null };

export type MapPlace = { name: string; region: string; count: number; lat: number; lon: number };
/** markers：[照片 ID, 纬度, 经度]（GPS 坐标） */
export type MapTiles = 'osm' | 'amap' | 'tianditu';
/** tiandituKey：底图是天地图时，浏览器加载瓦片要带的 Key */
export type MapData = { tiles: MapTiles; tiandituKey: string | null; markers: [string, number, number][]; places: MapPlace[] };
export type AppSettings = { mapTiles: MapTiles; tiandituKey: string | null };

export type Companion = { id: string; name: string; count: number; thumbnailUrl: string };
export type UnnamedPerson = { id: string; assets: number; withBaby: number; thumbnailUrl: string };

export function useCompanions(babyId: number) {
  const album = useAlbum();
  return useQuery({
    queryKey: [album.base, 'companions', babyId],
    queryFn: () => get<Companion[]>(`${album.base}/babies/${babyId}/companions`),
    staleTime: 5 * 60_000,
    enabled: babyId > 0,
  });
}

// ---------------------------------------------------------------- 手动相册

export type PhotoAlbum = { id: number; title: string; description: string; coverAssetId: string | null; createdBy: number | null; createdAt: string; updatedAt: string; count: number };

export function useAlbums() {
  return useQuery({ queryKey: ['/api', 'albums'], queryFn: () => get<PhotoAlbum[]>('/api/albums') });
}

export function useAlbumDetail(id: number) {
  return useQuery({ queryKey: ['/api', 'albums', id], queryFn: () => get<{ album: PhotoAlbum; items: AlbumItem[] }>(`/api/albums/${id}`) });
}

// ---------------------------------------------------------------- 点赞、留言

export type Social = {
  likes: { name: string; mine: boolean }[];
  comments: { id: number; name: string; text: string; createdAt: string; mine: boolean; canDelete: boolean }[];
};
export type RecentInteraction = { kind: 'comment' | 'like'; assetId: string; name: string; text: string; createdAt: string; mine: boolean };

// ---------------------------------------------------------------- 推送偏好、系统状态

export type NotifyPrefs = { milestones: boolean; weekly: boolean; family: boolean; system: boolean };
export type HealthCheck = { key: string; label: string; status: 'ok' | 'warn' | 'error' | 'skip'; message: string; hint?: string };
export type HealthReport = { checkedAt: string; checks: HealthCheck[] };
