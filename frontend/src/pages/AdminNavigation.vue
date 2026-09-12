<template>
  <w-page class="admin-navigation">
    <div class="flex flex-wrap p-4 items-center">
      <div class="flex-none">
        <img
          class="admin-icon animated fadeInLeft"
          src="/_assets/icons/fluent-tree-structure.svg" />
      </div>
      <div class="min-w-0 flex-1 pl-4">
        <div class="text-h5 admin-page-title animated fadeInLeft">
          {{ t('admin.navigation.title') }}
        </div>
        <div class="text-subtitle1 text-grey animated fadeInLeft wait-p2s">
          {{ t('admin.navigation.subtitle') }}
        </div>
      </div>
      <div class="flex-none">
        <w-btn
          class="acrylic-btn mr-2"
          icon="la:question-circle"
          flat
          color="grey"
          :aria-label="t(`common.actions.viewDocs`)"
          :href="siteStore.docsBase + `/admin/navigation`"
          target="_blank">
          <w-tooltip>{{ t(`common.actions.viewDocs`) }}</w-tooltip>
        </w-btn>
        <w-btn
          class="mr-2 acrylic-btn"
          icon="la:redo-alt"
          flat
          color="secondary"
          :loading="state.loading > 0"
          :aria-label="t(`common.actions.refresh`)"
          @click="load">
          <w-tooltip>{{ t(`common.actions.refresh`) }}</w-tooltip>
        </w-btn>
        <w-btn
          v-if="canManage"
          unelevated
          icon="mdi:playlist-edit"
          :label="t(`navEdit.editMenuItems`)"
          color="secondary"
          :disabled="state.loading > 0 || !state.navigationId"
          @click="edit" />
      </div>
    </div>
    <w-separator inset />
    <div class="p-4">
      <w-card>
        <w-card-section class="card-header flex items-center">
          <w-icon name="img:/_assets/icons/fluent-sidebar-menu.svg" left size="sm" />
          <span>{{ t('admin.navigation.siteMenu') }}</span>
          <w-space />
          <!--
            Only where there is a choice to make: the site-wide menu is per locale, so a wiki written
            in one language has exactly one and a picker showing it would be a control with a single
            option.
          -->
          <w-select
            v-if="localeOptions.length > 1"
            style="min-width: 200px"
            outlined
            dense
            options-dense
            hide-bottom-space
            v-model="state.locale"
            :options="localeOptions"
            option-value="code"
            option-label="name"
            emit-value
            map-options
            :aria-label="t(`admin.navigation.locale`)"
            @update:model-value="loadMenu" />
        </w-card-section>
        <w-card-section class="text-caption text-grey">
          {{ t('admin.navigation.siteMenuHint') }}
        </w-card-section>
        <w-separator />
        <w-list dense>
          <w-item v-if="rows.length < 1">
            <w-item-section class="text-grey">{{ t('admin.navigation.emptyList') }}</w-item-section>
          </w-item>
          <w-item v-for="row of rows" :key="row.id" dense :class="row.nested ? 'pl-8' : ''">
            <w-item-section side>
              <w-icon :name="rowIcon(row)" :color="row.type === `link` ? `primary` : `grey`" />
            </w-item-section>
            <w-item-section>
              <w-item-label>{{ row.label || t(`navEdit.${row.type}`) }}</w-item-label>
              <w-item-label caption v-if="row.type === `link`">{{ row.target }}</w-item-label>
            </w-item-section>
            <!--
              What the reader has to belong to for the row to appear at all: an item limited to a
              group is missing from most people's sidebar, which is otherwise invisible from here.
            -->
            <w-item-section side v-if="row.visibilityGroups?.length > 0">
              <div class="text-caption text-grey">
                {{ t('admin.navigation.restrictedTo', { count: row.visibilityGroups.length }) }}
              </div>
            </w-item-section>
          </w-item>
        </w-list>
      </w-card>
    </div>
  </w-page>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { computed, onMounted, reactive, watch } from 'vue'

import { useMeta } from '@/composables/meta'
import { notify } from '@/composables/notify'

import { useAdminStore } from '@/stores/admin'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

import { apiErrorMessage } from '@/helpers/apiError'

// STORES

const adminStore = useAdminStore()
const siteStore = useSiteStore()
const userStore = useUserStore()

// I18N

const { t } = useI18n()

// META

useMeta(() => ({
  title: t('admin.navigation.title')
}))

// DATA

const state = reactive({
  loading: 0,
  /** Locale codes this site has active — which locales have a site-wide menu at all. */
  active: [],
  locale: '',
  /** The menu the locale resolves to, which the editor is opened on. */
  navigationId: null,
  items: []
})

// COMPUTED

/*
  Saving needs `manage:navigation` (see `api/navigation.ts`), so the action that would perform one is
  hidden rather than left to fail at the API. The listing above it needs the same permission and comes
  back empty for anyone else, which is the server's answer and not this page's.
*/
const canManage = computed(() => userStore.can('manage:navigation'))

/** The site's active locales, named as the wiki names them rather than by bare code. */
const localeOptions = computed(() =>
  state.active.map((code) => ({
    code,
    name: adminStore.locales.find((lc) => lc.code === code)?.name ?? code
  }))
)

/**
 * The menu as one list of rows, a submenu's entries following the link that holds them.
 *
 * Flat because this is a summary and not the editor: two levels of `v-for` would say nothing an
 * indent does not, and the editor itself works on a flat list for the same reason.
 */
const rows = computed(() =>
  state.items.flatMap((item) => [
    { ...item, nested: false },
    ...(item.children ?? []).map((child) => ({ ...child, nested: true }))
  ])
)

// WATCHERS

// -> Set by `AdminLayout` after this page has mounted when the admin area is opened straight at this
//    URL, so the first load is this watcher's rather than `onMounted`'s
watch(() => adminStore.currentSiteId, load)

watch(
  () => adminStore.overlay,
  (newValue, oldValue) => {
    // -> The editor saves the menu itself, so what is on screen here is stale the moment it closes
    if (!newValue && oldValue === 'NavEdit') {
      loadMenu()
    }
  }
)

// METHODS

function rowIcon(row) {
  switch (row.type) {
    case 'link': {
      return row.icon || 'mdi:text-box-outline'
    }
    case 'header': {
      return 'la:heading'
    }
    default: {
      return 'la:minus'
    }
  }
}

/**
 * The menu of the selected locale, in full.
 *
 * `full`, as the editor asks for it: an administrator has to see the items limited to groups they are
 * not in, or this screen would report a menu shorter than the one they are about to edit.
 */
async function loadMenu() {
  if (!state.locale) {
    return
  }
  state.loading++
  try {
    const menu = await API_CLIENT.get(
      `sites/${adminStore.currentSiteId}/navigation/site/${state.locale}`
    ).json()
    // -> The API client does not throw on 400, so a refusal comes back as a parsed error
    if (!menu?.navigationId) {
      throw new Error(menu?.message || t('common.error.unexpected'))
    }
    state.navigationId = menu.navigationId
    const items = await API_CLIENT.get(
      `sites/${adminStore.currentSiteId}/navigation/${menu.navigationId}`,
      { searchParams: { full: true } }
    ).json()
    state.items = Array.isArray(items) ? items : []
  } catch (err) {
    state.navigationId = null
    state.items = []
    notify({
      type: 'negative',
      message: apiErrorMessage(err)
    })
  }
  state.loading--
}

async function load() {
  state.loading++
  try {
    const site = await API_CLIENT.get(`sites/${adminStore.currentSiteId}`).json()
    state.active = site?.locales?.active ?? []
    if (!state.active.includes(state.locale)) {
      state.locale = site?.locales?.primary ?? state.active[0] ?? 'en'
    }
    await loadMenu()
  } catch (err) {
    notify({
      type: 'negative',
      message: apiErrorMessage(err)
    })
  }
  state.loading--
}

function edit() {
  adminStore.$patch({
    overlay: 'NavEdit',
    overlayOpts: {
      siteId: adminStore.currentSiteId,
      locale: state.locale,
      navId: state.navigationId
    }
  })
}

// MOUNTED

onMounted(() => {
  if (adminStore.currentSiteId) {
    load()
  }
})
</script>
