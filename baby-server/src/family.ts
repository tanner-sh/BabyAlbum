// 认识家里人：给常和宝宝一起出现的人物命名（爸爸、妈妈、奶奶……），之后可以看“宝宝和奶奶的合照”、全家福

import { cachedPhotos, tidyAssets } from './album.ts';
import { babies as babiesDb, dateOverrides, settings, type Baby } from './db.ts';
import { immich } from './immich.ts';

type Asset = immich.AssetResponseDto;

/** 已命名、没隐藏的人物（宝宝和家人） */
export function namedPeople() {
  return cachedPhotos('people:named', 5 * 60_000, async () => {
    const named = new Map<string, { id: string; name: string }>();
    for (let page = 1; page <= 20; page++) {
      const res = await immich.getAllPeople({ withHidden: false, page, size: 500 });
      for (const p of res.people) if (p.name && !p.isHidden) named.set(p.id, { id: p.id, name: p.name });
      if (!res.hasNextPage) break;
    }
    return named;
  });
}

/** 两个人物同框的照片数 */
function together(a: string, b: string) {
  return cachedPhotos(`together:${a}:${b}`, 10 * 60_000, () =>
    immich.searchAssetStatistics({ statisticsSearchDto: { personIds: [a, b], visibility: immich.AssetVisibility.Timeline } }).then((r) => r.total),
  );
}

/** 和宝宝同框过的家人（已命名的），按合照数量排序 */
export async function companions(baby: Baby) {
  const babyIds = new Set(babiesDb.list().map((b) => b.immichPersonId));
  const people = [...(await namedPeople()).values()].filter((p) => !babyIds.has(p.id));
  const counts = await Promise.all(people.map((p) => together(baby.immichPersonId, p.id).catch(() => 0)));
  return people
    .map((p, i) => ({ id: p.id, name: p.name, count: counts[i], thumbnailUrl: `/api/people/${p.id}/thumbnail` }))
    .filter((p) => p.count > 0)
    .sort((a, b) => b.count - a.count);
}

/** 全家福：宝宝和至少两位已命名的家人同框的照片，按拍摄时间倒序 */
export function familyPhotos(baby: Baby) {
  return cachedPhotos(`family:${baby.immichPersonId}`, 30 * 60_000, async () => {
    const named = await namedPeople();
    const babyIds = new Set(babiesDb.list().map((b) => b.immichPersonId));
    const found: Asset[] = [];
    for (let page = 1; page <= 100; page++) {
      const { assets } = await immich.searchAssets({
        metadataSearchDto: { personIds: [baby.immichPersonId], withPeople: true, size: 1000, page, visibility: immich.AssetVisibility.Timeline },
      });
      for (const a of assets.items) {
        const family = (a.people ?? []).filter((p) => named.has(p.id) && !babyIds.has(p.id));
        if (family.length >= 2) found.push(a);
      }
      if (!assets.nextPage) break;
    }
    const overrides = dateOverrides.all();
    const list = (await tidyAssets(found)).map((a) => (overrides.has(a.id) ? { ...a, localDateTime: `${overrides.get(a.id)}.000Z` } : a));
    return list.sort((a, b) => b.localDateTime.localeCompare(a.localDateTime));
  });
}

// ---------------------------------------------------------------- 这几位是谁？

const skipped = () => new Set<string>(JSON.parse(settings.get('people.skipped') ?? '[]'));

export function skipPerson(id: string) {
  const set = skipped();
  set.add(id);
  settings.set('people.skipped', JSON.stringify([...set].slice(-1000)));
}

/**
 * 还没命名、照片多的人物，经常和宝宝同框的排在前面（多半是家里人）。
 * 照片太少的（可能是路人、误识别）不列
 */
export async function unnamedPeople(limit = 12) {
  const babies = babiesDb.list();
  const babyIds = new Set(babies.map((b) => b.immichPersonId));
  const skip = skipped();
  const { people } = await immich.getAllPeople({ withHidden: false, page: 1, size: 200 });
  const candidates = people.filter((p) => !p.name && !babyIds.has(p.id) && !skip.has(p.id)).slice(0, 40);
  const stats = await Promise.all(
    candidates.map(async (p) => {
      const [assets, withBaby] = await Promise.all([
        immich.getPersonStatistics({ id: p.id }).then((s) => s.assets).catch(() => 0),
        Promise.all(babies.map((b) => together(b.immichPersonId, p.id).catch(() => 0))).then((n) => n.reduce((x, y) => x + y, 0)),
      ]);
      return { id: p.id, assets, withBaby, thumbnailUrl: `/api/people/${p.id}/thumbnail` };
    }),
  );
  return stats
    .filter((p) => p.assets >= 10)
    .sort((a, b) => b.withBaby - a.withBaby || b.assets - a.assets)
    .slice(0, limit);
}
