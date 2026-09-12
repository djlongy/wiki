import { sql } from 'drizzle-orm'
import type { AccessActor } from './groups.ts'
import type { PageActor } from './pages.ts'

export interface Tag {
  tag: string
  usageCount: number
}

/** What a rename or a delete across pages did, per page it found. */
export interface TagChange {
  /** Pages whose tag list was rewritten. */
  updated: number
  /** Pages carrying the tag that the actor may not write, and which were therefore left alone. */
  skipped: number
}

/**
 * Tags
 *
 * A tag is not a row anybody creates: it exists because a page carries it, in `pages.tags`. The list
 * is therefore derived rather than stored, which is what keeps it from drifting out of step with the
 * pages after an edit, a delete or a restore.
 *
 * NOTE: the `tags` table in the schema is a leftover of an earlier design and is never written to.
 * Reading from it here would answer every request with an empty list.
 */
class Tags {
  /**
   * Every tag used by a page of this site, most used first
   *
   * @param siteId Site the pages belong to
   * @param limit Ceiling on how many distinct tags come back, most used first
   * @param actor Who is asking. Given one, the list is built only from the pages they may read —
   *              a tag is the name of something on a page, and the set of tags in use tells a
   *              reader what a wiki is about. Counted over readable pages too, so the numbers agree
   *              with what a search for the tag would return.
   */
  async getTags(
    siteId: string,
    { limit = 1000, actor }: { limit?: number; actor?: AccessActor } = {}
  ): Promise<Tag[]> {
    if (!actor) {
      const result = await WIKI.db.execute(sql`
        SELECT tag, COUNT(*)::int AS "usageCount"
        FROM pages, unnest(tags) AS tag
        WHERE "siteId" = ${siteId}
        GROUP BY tag
        ORDER BY COUNT(*) DESC, tag ASC
        LIMIT ${limit}
      `)
      return ((result.rows ?? result) as any[]).map((row) => ({
        tag: row.tag as string,
        usageCount: row.usageCount as number
      }))
    }

    /*
      Aggregated here rather than in postgres, because which pages count depends on the page rules and
      a rule can be a regular expression or a set of tags — neither of which a `GROUP BY` could take
      into account. Only tagged pages are read, and only their path, locale and tags.
    */
    const result = await WIKI.db.execute(sql`
      SELECT path, locale, tags
      FROM pages
      WHERE "siteId" = ${siteId} AND array_length(tags, 1) > 0
    `)
    const counts = new Map<string, number>()
    for (const row of (result.rows ?? result) as any[]) {
      const page = {
        path: row.path as string,
        locale: row.locale as string,
        tags: (row.tags ?? []) as string[]
      }
      if (!WIKI.models.groups.checkAccess(actor, 'read:pages', page)) {
        continue
      }
      for (const tag of page.tags) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1)
      }
    }
    return [...counts.entries()]
      .map(([tag, usageCount]) => ({ tag, usageCount }))
      .sort((a, b) => b.usageCount - a.usageCount || a.tag.localeCompare(b.tag))
      .slice(0, limit)
  }

  /**
   * Rename a tag across every page carrying it, or take it off them.
   *
   * The only two things a tag can be administered as: it has no row of its own to edit, so there is
   * nothing else about it to change. `to` of null is the delete.
   *
   * One page at a time through `updatePage` rather than one statement against `pages.tags`, for the
   * reason `deletePagesByTag` takes the same route: a tag is mirrored onto `tree.tags`, a change to a
   * page is a history version, and the page's stored copy carries its tags in front matter. A bulk
   * `UPDATE` would write the column and leave all three behind.
   *
   * Checked per page rather than once for the caller, because `manage:pages` at the route says only
   * that this is an administrative action -- which pages it may actually rewrite is a page rule, the
   * same question `write:pages` answers everywhere else. A page the actor may not write is left
   * exactly as it was and counted, so the caller is told the rename was partial rather than being
   * shown a number that quietly means something narrower than "all of them".
   *
   * @param from The tag as it is now
   * @param to What to call it instead, or null to remove it
   * @returns What changed, or null if no page carries the tag at all
   */
  async renameTag(
    siteId: string,
    from: string,
    to: string | null,
    actor: PageActor & AccessActor
  ): Promise<TagChange | null> {
    const result = await WIKI.db.execute(sql`
      SELECT id, path, locale, tags
      FROM pages
      WHERE "siteId" = ${siteId} AND tags @> ARRAY[${from}]::text[]
    `)
    const rows = ((result.rows ?? result) as any[]).map((row) => ({
      id: row.id as string,
      path: row.path as string,
      locale: row.locale as string,
      tags: (row.tags ?? []) as string[]
    }))
    if (rows.length < 1) {
      return null
    }

    const change: TagChange = { updated: 0, skipped: 0 }
    for (const page of rows) {
      if (!WIKI.models.groups.checkAccess(actor, 'write:pages', page)) {
        change.skipped++
        continue
      }
      /*
        A Set, because the new name may already be on the page: `alpha` renamed to `beta` on a page
        carrying both has to leave one `beta`, not two. Order is otherwise the page's own, so a rename
        does not silently reshuffle a tag list nobody asked it to touch.
      */
      const next = new Set(page.tags)
      next.delete(from)
      if (to !== null) {
        next.add(to)
      }
      await WIKI.models.pages.updatePage(siteId, page.id, { tags: [...next] }, actor)
      change.updated++
    }
    return change
  }

  /**
   * How many distinct tags are in use, across every site
   *
   * Derived from `pages.tags` for the same reason the list is: the `tags` table is never written to,
   * so counting rows there answers 0 on every wiki. Unscoped and unfiltered, to match the other
   * totals it is reported alongside — the system info page and the metrics endpoint both count the
   * whole instance, and both are for an operator rather than a reader.
   */
  async countDistinct(): Promise<number> {
    const result = await WIKI.db.execute(sql`
      SELECT count(DISTINCT tag)::int AS total
      FROM pages, unnest(tags) AS tag
    `)
    return (((result.rows ?? result) as any[])[0]?.total as number) ?? 0
  }
}

export const tags = new Tags()
