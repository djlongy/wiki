<template>
  <w-layout>
    <w-header><header-nav /></w-header>
    <w-page-container class="layout-tags">
      <div class="layout-tags-card">
        <!--
          THE TAGS
          ========
          The whole point of the screen, so they are the top of it rather than a filter beside it: a
          reader arriving here has not chosen anything yet, and what they came for is to see what the
          wiki is about. Counts are on the chips because a tag carried by one page and a tag carried by
          forty are different answers to that question.
        -->
        <div class="layout-tags-head">
          <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h1 class="text-h6 leading-tight">{{ t('tags.title') }}</h1>
            <span class="text-caption text-grey">{{ t('tags.subtitle') }}</span>
          </div>
          <div class="mt-3 flex flex-wrap items-center gap-1" v-if="allTags.length > 0">
            <w-chip
              v-for="item of allTags"
              :key="`tag-` + item.tag"
              square
              :color="isSelected(item.tag) ? `primary` : `grey-8`"
              text-color="white"
              icon="la:hashtag"
              size="sm"
              clickable
              :aria-pressed="isSelected(item.tag)"
              @click="toggleTag(item.tag)">
              {{ item.tag }}
              <span class="layout-tags-count">{{ item.usageCount }}</span>
            </w-chip>
          </div>
          <div v-else-if="state.loading < 1" class="text-body2 text-grey mt-3">
            {{ t('admin.tags.noItemsText') }}
          </div>

          <!--
            The selection again, as something to clear. The chips above say what is chosen by their
            colour, which is the wrong thing to hunt for in a list of two hundred once a few are on.
          -->
          <div v-if="selectedTags.length > 0" class="mt-3 flex flex-wrap items-center gap-2">
            <span class="text-caption text-grey">{{ t('tags.currentSelection') }}:</span>
            <w-chip
              v-for="tag of selectedTags"
              :key="`sel-` + tag"
              square
              color="primary"
              text-color="white"
              icon="la:hashtag"
              size="sm"
              removable
              @remove="toggleTag(tag)"
              >{{ tag }}</w-chip
            >
            <w-btn
              class="acrylic-btn"
              flat
              size="xs"
              no-caps
              :label="t(`tags.clearSelection`)"
              color="grey"
              @click="setSelection([])" />
          </div>
        </div>

        <!--
          THE PAGES
          =========
          Nothing until a tag is chosen: with none selected the search API is being asked for every page
          on the wiki, which is a site map rather than an answer, and the hint says what to do instead.
        -->
        <w-page>
          <div class="section-header flex items-center">
            <span>{{ t('search.results') }}</span>
            <w-space />
            <w-input
              v-if="state.results.length > 0"
              class="denser"
              outlined
              dense
              v-model="state.filter"
              :aria-label="t(`tags.searchWithinResultsPlaceholder`)"
              :placeholder="t(`tags.searchWithinResultsPlaceholder`)">
              <template #prepend><w-icon name="la:search" size="xs" /></template>
            </w-input>
          </div>
          <w-list separator>
            <w-item v-if="selectedTags.length < 1">
              <w-item-section side><w-icon name="la:hashtag" color="grey" /></w-item-section>
              <!-- -> `selectOneMoreTags`, not `selectOneMoreTagsHint`: the hint reads "on the left",
                      which was true of the sidebar this screen does not have. -->
              <w-item-section class="text-grey">{{ t('tags.selectOneMoreTags') }}</w-item-section>
            </w-item>
            <w-item v-else-if="state.loading > 0">
              <w-item-section side><w-icon name="la:hourglass-half" color="grey" /></w-item-section>
              <w-item-section class="text-grey">{{
                t('tags.retrievingResultsLoading')
              }}</w-item-section>
            </w-item>
            <w-item v-else-if="visibleResults.length < 1">
              <w-item-section side><w-icon name="la:times-circle" color="grey" /></w-item-section>
              <w-item-section class="text-grey">{{
                state.filter ? t('tags.noResultsWithFilter') : t('tags.noResults')
              }}</w-item-section>
            </w-item>
            <w-item
              v-for="item of visibleResults"
              :key="item.id"
              clickable
              :to="pageUrl(item)">
              <w-item-section avatar>
                <w-icon :name="item.icon || defaultPageIcon" color="primary" />
              </w-item-section>
              <w-item-section>
                <w-item-label>{{ item.title }}</w-item-label>
                <w-item-label caption>{{ pageUrl(item) }}</w-item-label>
                <w-item-label v-if="item.description" caption>{{ item.description }}</w-item-label>
              </w-item-section>
              <w-item-section side>
                <div class="text-caption text-right">
                  {{ t('tags.pageLastUpdated', { date: humanizeDate(item.updatedAt) }) }}
                </div>
                <div class="mt-1 flex flex-wrap items-center justify-end gap-1">
                  <w-chip
                    v-for="tag of item.tags"
                    :key="`itemtag-` + tag"
                    square
                    :color="isSelected(tag) ? `primary` : `secondary`"
                    text-color="white"
                    icon="la:hashtag"
                    size="sm"
                    >{{ tag }}</w-chip
                  >
                </div>
              </w-item-section>
            </w-item>
          </w-list>
        </w-page>
      </div>
      <w-footer><footer-nav /></w-footer>
    </w-page-container>
    <main-overlay-dialog />
  </w-layout>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { computed, onMounted, reactive, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'

import { useMeta } from '@/composables/meta'
import { notify } from '@/composables/notify'

import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'
import { DEFAULT_PAGE_ICON } from '@/stores/page'

import HeaderNav from '@/components/HeaderNav.vue'
import FooterNav from '@/components/FooterNav.vue'
import MainOverlayDialog from '@/components/MainOverlayDialog.vue'
import { apiErrorMessage } from '@/helpers/apiError'

/** How many pages one selection lists. The search API caps this at 100, and there is no pager yet. */
const RESULTS_LIMIT = 100

// STORES

const siteStore = useSiteStore()
const userStore = useUserStore()

// ROUTER

const router = useRouter()
const route = useRoute()

// I18N

const { t } = useI18n()

// META

useMeta(() => {
  const siteTitle = siteStore.title
  return {
    title: t('tags.title'),
    titleTemplate: (title) => `${title} - ${siteTitle}`
  }
})

// DATA

const state = reactive({
  loading: 0,
  /** Narrows the results already fetched. Not sent to the server: it filters a list, not a search. */
  filter: '',
  results: []
})

// COMPUTED

/**
 * The tags to browse, alphabetically.
 *
 * `GET /sites/:siteId/tags` answers most-used first, which is what makes its `limit` mean the tags a
 * wiki is actually about. Reordered here because this is a list to FIND a tag in rather than a list of
 * the top few: usage order puts `zebra` above `alpha` for no reason the reader can see. The count
 * travels with each one, so what usage order was carrying is still on screen.
 *
 * `localeCompare` rather than a plain `sort()`, as `PageTags` and `Search` both do: a tag is a
 * page-authored word, and code-unit order scatters every non-ASCII one.
 */
const allTags = computed(() =>
  [...siteStore.tags].sort((a, b) => a.tag.localeCompare(b.tag))
)

/**
 * What is selected, from the URL rather than from local state.
 *
 * The URL is the selection: that is what makes a tag chip on a page a link to here, what puts the
 * browser's Back button between two selections, and what lets a reader hand somebody else the set they
 * are looking at. Comma-separated, which is how every other multi-valued filter reaches this API.
 */
const selectedTags = computed(() =>
  String(route.query.tags ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
)

/** The fetched pages, narrowed by the filter box. Title and path, which is what a row shows. */
const visibleResults = computed(() => {
  const needle = state.filter.trim().toLowerCase()
  if (!needle) {
    return state.results
  }
  return state.results.filter(
    (r) =>
      r.title?.toLowerCase().includes(needle) ||
      r.path?.toLowerCase().includes(needle) ||
      r.description?.toLowerCase().includes(needle)
  )
})

const defaultPageIcon = DEFAULT_PAGE_ICON

// WATCHERS

watch(() => route.query.tags, fetchResults, { immediate: true })

// METHODS

function isSelected(tag) {
  return selectedTags.value.includes(tag)
}

function toggleTag(tag) {
  setSelection(
    isSelected(tag) ? selectedTags.value.filter((t) => t !== tag) : [...selectedTags.value, tag]
  )
}

/** The selection lives in the URL, so changing it is a navigation. */
function setSelection(tags) {
  router.push({ path: '/_tags', query: tags.length > 0 ? { tags: tags.join(',') } : {} })
}

/**
 * Where a result leads.
 *
 * Per row rather than once for the list, as the search screen works it out: a tag spans every locale,
 * so two pages carrying it can be in different languages -- and a bare path is the primary locale's
 * address, which is either the wrong page or no page at all.
 */
function pageUrl(item) {
  return `${siteStore.localeUrlPrefix(item.locale)}/${item.path}`
}

function humanizeDate(val) {
  return userStore.formatDateTime(t, val)
}

/**
 * The pages carrying every selected tag.
 *
 * Through the search API with no query text, which is its explicit browse mode: the filters alone
 * decide the results, and it applies the page rules per row -- so this asks for nothing the reader may
 * not see, and needs no permission handling of its own.
 */
async function fetchResults() {
  if (selectedTags.value.length < 1) {
    state.results = []
    return
  }
  state.loading++
  try {
    const resp = await API_CLIENT.get(`sites/${siteStore.id}/pages/search`, {
      searchParams: {
        tags: selectedTags.value.join(','),
        // -> Alphabetical: there is no query to be relevant to, and a browse wants a stable order
        orderBy: 'title',
        orderByDirection: 'asc',
        limit: RESULTS_LIMIT
      }
    }).json()
    state.results = (resp?.results ?? []).map((r) => ({ ...r, tags: [...(r.tags ?? [])].sort() }))
  } catch (err) {
    state.results = []
    notify({
      type: 'negative',
      message: t('search.failed'),
      caption: apiErrorMessage(err)
    })
  }
  state.loading--
}

// MOUNTED

onMounted(async () => {
  state.loading++
  try {
    await siteStore.fetchTags()
  } catch (err) {
    notify({
      type: 'negative',
      message: t('search.failed'),
      caption: apiErrorMessage(err)
    })
  }
  state.loading--
})
</script>

<style lang="scss">
/*
  One column, unlike the search screen's card-beside-a-sidebar: the tags are the subject here rather
  than a filter on something else, so they are the top of the sheet and the pages are under them. That
  is also why this needs none of `layout-search`'s three narrower layouts -- a column already stacks.
*/
.layout-tags {
  @at-root .body--light & {
    background-color: $grey-3;
  }
  @at-root .body--dark & {
    background-color: $dark-6;
  }

  &-card {
    position: relative;
    width: 90%;
    max-width: 1400px;
    margin: 50px auto;
    box-shadow: $shadow-2;
    border-radius: 7px;
    overflow: hidden;

    /*
      Both halves of the surface, as the search card needs for the same reason: this is a plain div
      rather than a WCard, and with only a background set everything inside inherits the document's
      black -- which is invisible on the dark one.
    */
    @at-root .body--light & {
      background-color: #fff;
      color: var(--color-black);
    }
    @at-root .body--dark & {
      background-color: $dark-3;
      color: var(--color-white);
    }
  }

  &-head {
    padding: 1rem;
  }

  /* -> The usage count, quiet enough not to be read as part of the tag itself */
  &-count {
    margin-left: 0.4rem;
    opacity: 0.6;
    font-variant-numeric: tabular-nums;
  }

  .section-header {
    padding: 0.75rem 1rem;
    font-weight: 500;
    color: $primary;

    @at-root .body--light & {
      background-color: $grey-1;
      border-top: 1px solid $grey-3;
      border-bottom: 1px solid $grey-3;
    }
    @at-root .body--dark & {
      // -> Same lightened brand blue as `.w-section-header`; `$primary` on this surface is ~2.7:1
      color: var(--color-primary-light);
      background-color: $dark-4;
      border-top: 1px solid $dark-2;
      border-bottom: 1px solid $dark-2;
    }
  }

  /* -> The card is the screen below 600px, as the search card is */
  @media (max-width: $breakpoint-xs-max) {
    &-card {
      width: 100%;
      margin: 0;
      border-radius: 0;
      box-shadow: none;
    }
  }
}

body.body--dark {
  background-color: $dark-6;
}
</style>
