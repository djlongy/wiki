<template>
  <w-page class="admin-tags">
    <div class="flex flex-wrap p-4 items-center">
      <div class="flex-none">
        <img class="admin-icon animated fadeInLeft" src="/_assets/icons/fluent-tag.svg" />
      </div>
      <div class="min-w-0 flex-1 pl-4">
        <div class="text-h5 admin-page-title animated fadeInLeft">{{ t('admin.tags.title') }}</div>
        <div class="text-subtitle1 text-grey animated fadeInLeft wait-p2s">
          {{ t('admin.tags.subtitle') }}
        </div>
      </div>
      <div class="flex-none flex items-center">
        <w-input
          class="denser mr-2"
          outlined
          v-model="state.search"
          dense
          :aria-label="t(`admin.tags.filter`)"
          :placeholder="t(`admin.tags.filter`)"
          :class="dark.isActive ? `bg-dark text-white` : `bg-white`">
          <template #prepend><w-icon class="opacity-50" name="la:search" size="20px" /></template>
        </w-input>
        <w-btn
          class="mr-2 acrylic-btn"
          icon="la:redo-alt"
          flat
          color="secondary"
          :aria-label="t(`common.actions.refresh`)"
          @click="refresh"
          :loading="state.loading > 0">
          <w-tooltip>{{ t(`common.actions.refresh`) }}</w-tooltip>
        </w-btn>
      </div>
    </div>
    <w-separator inset />
    <div class="grid grid-cols-12 p-4 gap-4">
      <div class="col-span-12">
        <w-card>
          <w-table
            :rows="state.tags"
            :columns="headers"
            row-key="tag"
            flat
            :loading="state.loading > 0"
            :filter="state.search">
            <template v-slot:body-cell-icon="props">
              <w-td :props="props"><w-icon name="la:hashtag" color="primary" size="sm" /></w-td>
            </template>
            <template v-slot:body-cell-tag="props">
              <w-td :props="props"
                ><strong>{{ props.value }}</strong></w-td
              >
            </template>
            <template v-slot:body-cell-usagecount="props">
              <w-td :props="props">
                <w-chip
                  class="text-caption"
                  square
                  :color="dark.isActive ? `dark-6` : `grey-2`"
                  :text-color="dark.isActive ? `white` : `grey-8`"
                  dense
                  >{{ t('admin.tags.pageCount', { count: props.value }, props.value) }}</w-chip
                >
              </w-td>
            </template>
            <template v-slot:body-cell-actions="props">
              <w-td :props="props">
                <!--
                  To the reader's tags page rather than to a listing of its own: it lists exactly these
                  pages, filtered by what the reader may see, and there is no second version of that
                  worth maintaining in here.
                -->
                <w-btn
                  class="acrylic-btn mr-2"
                  flat
                  icon="la:eye"
                  :color="dark.isActive ? `indigo-4` : `indigo`"
                  :label="t(`admin.tags.viewLinkedPages`)"
                  :to="`/_tags?tags=` + encodeURIComponent(props.row.tag)"
                  no-caps />
                <w-btn
                  class="acrylic-btn mr-2"
                  v-if="canManage"
                  flat
                  icon="la:pen"
                  :color="dark.isActive ? `indigo-4` : `indigo`"
                  :label="t(`common.actions.rename`)"
                  no-caps
                  @click="renameTag(props.row)" />
                <w-btn
                  class="acrylic-btn"
                  v-if="canManage"
                  flat
                  icon="la:trash"
                  color="negative"
                  :aria-label="t(`admin.tags.delete`)"
                  @click="deleteTag(props.row)">
                  <w-tooltip>{{ t(`admin.tags.delete`) }}</w-tooltip>
                </w-btn>
              </w-td>
            </template>
          </w-table>
          <!--
            WTable renders an empty tbody and nothing else when there are no rows, so the empty state
            is a sibling. Two messages rather than one: nothing to display is a different situation
            from nothing matching what was typed in the filter.
          -->
          <w-card-section v-if="state.loading < 1 && state.tags.length < 1" class="text-center">
            <w-icon name="la:hashtag" size="32px" class="text-grey" />
            <div class="text-body2 mt-2">{{ t('admin.tags.emptyList') }}</div>
            <div class="text-caption text-grey mt-1">{{ t('admin.tags.noItemsText') }}</div>
          </w-card-section>
        </w-card>
      </div>
    </div>
  </w-page>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { computed, onMounted, reactive } from 'vue'

import { useDark } from '@/composables/dark'
import { useMeta } from '@/composables/meta'
import { notify } from '@/composables/notify'
import { loading } from '@/composables/loading'
import { confirm, dialog } from '@/composables/dialog'

import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'
import { apiErrorMessage } from '@/helpers/apiError'

import TagRenameDialog from '../components/TagRenameDialog.vue'

// COMPOSABLES

const dark = useDark()

// STORES

const siteStore = useSiteStore()
const userStore = useUserStore()

// I18N

const { t } = useI18n()

// META

useMeta(() => ({
  title: t('admin.tags.title')
}))

// COMPUTED

/*
  Reading the list needs nothing -- the endpoint answers whoever asks, filtered to the pages they may
  read -- while renaming and deleting need `manage:pages`. The controls behind that are hidden rather
  than left to fail at the API, as the groups screen hides its own.
*/
const canManage = computed(() => userStore.can('manage:pages'))

// DATA

const state = reactive({
  tags: [],
  loading: 0,
  search: ''
})

/*
  Computed, not a plain array: the locale strings are fetched after the component sets up, so `t()`
  called once at setup time returns the key itself -- which is what this table's two headers rendered.
  The other admin tables get away with a const because they pass `hide-header`.

  `admin.tags.pageCount` is the plural form in the cell; the column is headed with the plain noun.
*/
const headers = computed(() => [
  {
    align: 'center',
    field: 'icon',
    name: 'icon',
    sortable: false,
    style: 'width: 20px'
  },
  {
    label: t('admin.tags.tag'),
    align: 'left',
    field: 'tag',
    name: 'tag',
    sortable: true
  },
  {
    label: t('admin.dashboard.pages'),
    align: 'center',
    field: 'usageCount',
    name: 'usagecount',
    sortable: true,
    style: 'width: 150px'
  },
  {
    label: '',
    align: 'right',
    field: 'actions',
    name: 'actions',
    sortable: false,
    style: 'width: 380px'
  }
])

// METHODS

async function load() {
  state.loading++
  loading.show()
  try {
    state.tags = await API_CLIENT.get(`sites/${siteStore.id}/tags`).json()
  } catch (err) {
    notify({
      type: 'negative',
      message: 'Failed to load tags.',
      caption: apiErrorMessage(err)
    })
  }
  loading.hide()
  state.loading--
}

/**
 * Reload, and tell the rest of the app its copy is out of date.
 *
 * The site store caches the tag list for the editor's field, the search filter and the header panel.
 * A rename made here changes what all three should offer, and nothing else invalidates it -- only a
 * page save does.
 */
async function refresh() {
  siteStore.staleTags()
  await load()
  notify({
    type: 'positive',
    message: t('admin.tags.refreshSuccess')
  })
}

function renameTag(row) {
  dialog({
    component: TagRenameDialog,
    componentProps: { tag: row.tag }
  }).onOk(() => {
    siteStore.staleTags()
    load()
  })
}

function deleteTag(row) {
  confirm({
    title: t('admin.tags.deleteConfirm'),
    message: t('admin.tags.deleteConfirmText', { tag: row.tag }),
    caption: t('admin.tags.pageCount', { count: row.usageCount }, row.usageCount),
    color: 'negative',
    okLabel: t('common.actions.delete'),
    cancel: true
  }).onOk(async () => {
    state.loading++
    try {
      const resp = await API_CLIENT.put(
        `sites/${siteStore.id}/tags/${encodeURIComponent(row.tag)}`,
        { json: { tag: null } }
      ).json()
      notify({
        type: 'positive',
        message: t('admin.tags.deleteSuccess'),
        // -> A delete can be partial, exactly as a rename can: pages the caller may not write keep
        //    the tag, and this is the only place that is said
        ...(resp?.skipped > 0
          ? { caption: t('admin.tags.partial', { count: resp.skipped }, resp.skipped) }
          : {})
      })
      siteStore.staleTags()
      await load()
    } catch (err) {
      notify({
        type: 'negative',
        message: apiErrorMessage(err)
      })
    }
    state.loading--
  })
}

// MOUNTED

onMounted(load)
</script>

<style lang="scss"></style>
