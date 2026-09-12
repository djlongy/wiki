<template>
  <w-dialog v-model="dialogVisible" @hide="onDialogHide">
    <w-card class="relative" style="min-width: 480px">
      <w-card-section class="card-header">
        <w-icon name="img:/_assets/icons/fluent-rename.svg" size="sm" class="mr-2" />
        <span>{{ t(`admin.tags.renameTitle`) }}</span>
      </w-card-section>
      <w-form ref="renameTagForm" class="p-4" @submit="rename">
        <w-input
          ref="iptTag"
          v-model="state.tag"
          outlined
          dense
          :rules="tagValidation"
          hide-bottom-space
          :label="t(`admin.tags.renameLabel`)"
          lazy-rules="ondemand"
          @keyup:enter="rename" />
      </w-form>
      <w-card-actions class="card-actions">
        <w-space />
        <w-btn
          class="acrylic-btn"
          flat
          :label="t(`common.actions.cancel`)"
          color="grey"
          padding="xs md"
          @click="onDialogCancel" />
        <w-btn
          unelevated
          :label="t(`common.actions.rename`)"
          color="primary"
          padding="xs md"
          :loading="state.loading > 0"
          @click="rename" />
      </w-card-actions>
      <w-inner-loading :showing="state.loading > 0" size="38px" spinner-class="text-accent" />
    </w-card>
  </w-dialog>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { reactive, ref } from 'vue'

import { dialogComponentEmits, useDialogComponent } from '@/composables/dialog'
import { notify } from '@/composables/notify'

import { useSiteStore } from '@/stores/site'
import { apiErrorMessage } from '@/helpers/apiError'

// PROPS

const props = defineProps({
  tag: {
    type: String,
    required: true
  }
})

// EMITS

defineEmits([...dialogComponentEmits])

// DIALOG

const { dialogVisible, onDialogHide, onDialogOK, onDialogCancel } = useDialogComponent({
  autofocus: () => iptTag.value
})

// STORES

const siteStore = useSiteStore()

// I18N

const { t } = useI18n()

// DATA

const state = reactive({
  tag: props.tag,
  loading: 0
})

// REFS

const renameTagForm = ref(null)
const iptTag = ref(null)

// VALIDATION RULES

/*
  Only what a tag cannot be. There is no allowed-character rule to enforce: the tag field on a page
  takes free text, so a tag already in use can be anything somebody typed, and refusing to rename it to
  something the editor would have accepted would be this screen inventing a rule of its own. A space is
  the one exception -- the search screen reads tags out of a query as `#token`, and a tag with a space
  in it cannot be written there.
*/
const tagValidation = [(val) => /^\S+$/.test(val.trim()) || t('admin.tags.renameInvalid')]

// METHODS

async function rename() {
  state.loading++
  try {
    const isFormValid = await renameTagForm.value.validate(true)
    if (!isFormValid) {
      throw new Error(t('admin.tags.renameInvalid'))
    }
    const resp = await API_CLIENT.put(
      `sites/${siteStore.id}/tags/${encodeURIComponent(props.tag)}`,
      { json: { tag: state.tag.trim() } }
    ).json()
    notify({
      type: 'positive',
      message: t('admin.tags.saveSuccess'),
      // -> A rename can be partial: pages the caller may not write are left as they were, and saying
      //    so here is the only place the reader would find out
      ...(resp?.skipped > 0
        ? { caption: t('admin.tags.partial', { count: resp.skipped }, resp.skipped) }
        : {})
    })
    onDialogOK()
  } catch (err) {
    notify({
      type: 'negative',
      message: apiErrorMessage(err)
    })
  }
  state.loading--
}
</script>
