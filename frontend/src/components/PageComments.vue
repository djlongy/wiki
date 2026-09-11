<template>
  <div class="page-comments" v-if="isVisible">
    <w-separator class="my-6" />
    <div class="mb-4 flex items-center gap-2">
      <w-icon name="la:comments" size="sm" />
      <span class="text-body1 font-medium">{{ t('common.comments.title') }}</span>
      <w-badge
        v-if="state.comments.length > 0"
        color="primary"
        :label="String(state.comments.length)" />
    </div>

    <div v-if="state.loading > 0" class="text-caption text-grey-7 py-4">
      {{ t('common.comments.loading') }}
    </div>
    <div v-else-if="state.comments.length < 1" class="text-caption text-grey-7 py-4">
      {{ mayWrite ? t('common.comments.beFirst') : t('common.comments.none') }}
    </div>

    <div
      v-for="comment of state.comments"
      :key="comment.id"
      class="page-comment flex gap-3 py-3"
      :class="
        state.comments.length > 1
          ? 'border-b border-black/8 last:border-0 dark:border-white/10'
          : ''
      ">
      <w-avatar size="36px" color="primary" text-color="white">
        <img v-if="comment.author.hasAvatar" :src="`/_user/${comment.author.id}/avatar`" alt="" />
        <span v-else>{{ initialOf(comment.author.name) }}</span>
      </w-avatar>
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-baseline gap-x-2">
          <span class="text-body2 font-medium">{{ comment.author.name }}</span>
          <span class="text-caption text-grey-7">{{ relativeDate(comment.createdAt) }}</span>
          <span class="text-caption text-grey-7" v-if="wasEdited(comment)">
            {{ t('common.comments.modified', { reldate: relativeDate(comment.updatedAt) }) }}
          </span>
          <w-space />
          <template v-if="mayModify(comment)">
            <w-btn
              flat
              dense
              size="sm"
              icon="la:edit"
              :aria-label="t('common.actions.edit')"
              @click="() => startEdit(comment)" />
            <w-btn
              flat
              dense
              size="sm"
              color="negative"
              icon="la:trash"
              :aria-label="t('common.actions.delete')"
              @click="() => removeComment(comment)" />
          </template>
        </div>

        <!--
          `v-html` with markup this component produced from the stored source. The renderer is
          `renderers/comment.js` and NOT the page one -- see the comment at the top of that file for
          why the difference is what keeps somebody else's markdown off this page.
        -->
        <div
          v-if="state.editingId !== comment.id"
          class="page-comment-body"
          v-html="renderComment(comment.content)" />
        <div v-else class="pt-2">
          <w-input
            v-model="state.editContent"
            type="textarea"
            outlined
            dense
            :rows="4"
            :label="t('common.comments.fieldContent')" />
          <div class="flex justify-end gap-2 pt-2">
            <w-btn
              flat
              color="grey"
              padding="xs md"
              :label="t('common.actions.cancel')"
              @click="cancelEdit" />
            <w-btn
              unelevated
              color="primary"
              padding="xs md"
              :disable="state.saving"
              :label="t('common.comments.updateComment')"
              @click="saveEdit" />
          </div>
        </div>
      </div>
    </div>

    <!-- NEW COMMENT -->
    <template v-if="mayWrite">
      <w-separator class="my-4" />
      <w-form ref="newForm" @submit="postComment">
        <div class="text-body2 mb-2">{{ t('common.comments.newComment') }}</div>
        <div class="text-caption text-grey-7 mb-2" v-if="userStore.authenticated">
          {{ t('common.comments.postingAs', { name: userStore.name }) }}
        </div>
        <template v-else>
          <div class="flex flex-wrap gap-2 pb-2">
            <div class="min-w-[200px] flex-1">
              <w-input
                v-model="state.guestName"
                outlined
                dense
                hide-bottom-space
                :rules="nameValidation"
                lazy-rules="ondemand"
                autocomplete="name"
                :label="t('common.comments.fieldName')" />
            </div>
            <div class="min-w-[200px] flex-1">
              <w-input
                v-model="state.guestEmail"
                outlined
                dense
                type="email"
                hide-bottom-space
                :rules="emailValidation"
                lazy-rules="ondemand"
                autocomplete="email"
                :label="t('common.comments.fieldEmail')" />
            </div>
          </div>
        </template>
        <w-input
          v-model="state.newContent"
          type="textarea"
          outlined
          dense
          :rows="4"
          :placeholder="t('common.comments.newPlaceholder')"
          :label="t('common.comments.fieldContent')" />
        <div class="flex items-center gap-2 pt-2">
          <span class="text-caption text-grey-7">{{ t('common.comments.markdownFormat') }}</span>
          <w-space />
          <w-btn
            unelevated
            color="primary"
            padding="xs md"
            :disable="state.saving || state.newContent.trim().length < 1"
            :label="t('common.comments.postComment')"
            @click="postComment" />
        </div>
      </w-form>
    </template>
  </div>
</template>

<script setup>
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { apiErrorMessage } from '@/helpers/apiError'
import { confirm } from '@/composables/dialog'
import { notify } from '@/composables/notify'
import { relativeDate } from '@/helpers/datetime'
import { renderComment } from '@/renderers/comment'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

/**
 * The comment thread under a page.
 *
 * Everything it shows or offers is decided by `userStore.pagePermissions` -- what the session holds AT
 * THIS PATH -- and not by `can()`, which ORs in the site-wide list and would answer "may comment
 * somewhere". Each of these is the same question the endpoint behind the control will ask.
 *
 * None of it is a security boundary: hiding the box is how a reader is told they cannot comment, and
 * `api/comments.ts` is what stops them. The two are deliberately the same three permission names, so
 * a control that is on and a request that is refused cannot happen to disagree.
 */

// STORES

const pageStore = usePageStore()
const siteStore = useSiteStore()
const userStore = useUserStore()

// I18N

const { t } = useI18n()

// DATA

const state = reactive({
  comments: [],
  loading: 0,
  saving: false,
  newContent: '',
  guestName: '',
  guestEmail: '',
  /** The comment currently open for editing, by id. One at a time. */
  editingId: null,
  editContent: ''
})

// REFS

const newForm = ref(null)

// COMPUTED

/**
 * Whether this reader may see the thread at all.
 *
 * Two gates, and they are different questions: the site switch is whether this wiki has comments, and
 * `read:comments` is whether this reader may see them here. A page with no id is one that is still
 * loading, or an error screen -- neither has a thread.
 */
const canRead = computed(
  () =>
    siteStore.features.comments &&
    Boolean(pageStore.id) &&
    userStore.pagePermissions.includes('read:comments')
)

/**
 * Whether to draw anything.
 *
 * A page closed to comments still SHOWS the ones already under it -- closing it stops the thread
 * growing, it does not hide what was said -- but a closed page with nothing under it has no thread to
 * head, so the whole section goes rather than leaving an empty heading over a "no comments yet".
 */
const isVisible = computed(
  () => canRead.value && (pageStore.allowComments || state.comments.length > 0)
)

// -> The page's own switch as well as the permission: the endpoint checks both
const mayWrite = computed(
  () => pageStore.allowComments && userStore.pagePermissions.includes('write:comments')
)
const mayManage = computed(() => userStore.pagePermissions.includes('manage:comments'))

// VALIDATION RULES

const nameValidation = [(val) => (val ?? '').trim().length > 0 || t('auth.errors.missingName')]

const emailValidation = [
  (val) => (val ?? '').trim().length > 0 || t('auth.errors.missingEmail'),
  (val) => /^.+@.+\..+$/.test(val) || t('auth.errors.invalidEmail')
]

// WATCHERS

/*
  The page under the thread, which changes without this component being torn down -- the page view
  swaps content in place. Reloading on the id covers a move too: the same thread, at a new path.
*/
watch(
  () => [pageStore.id, canRead.value],
  () => {
    resetForms()
    if (canRead.value) {
      fetchComments()
    } else {
      state.comments = []
    }
  },
  { immediate: true }
)

// METHODS

/**
 * Whether this reader may change or remove a comment.
 *
 * The same test the server makes: moderation covers anybody's, and otherwise a comment is its
 * author's. A guest never matches -- their comments carry no author id, and `authenticated` is what
 * stops "nobody" from being treated as a person.
 */
function mayModify(comment) {
  if (mayManage.value) {
    return true
  }
  return userStore.authenticated && Boolean(comment.author.id) && comment.author.id === userStore.id
}

/** An edit is only worth marking once it has actually happened; a stored comment starts out equal. */
function wasEdited(comment) {
  return comment.updatedAt !== comment.createdAt
}

/** The letter on a guest's avatar, who has no picture to show. */
function initialOf(name) {
  return (name ?? '').trim().charAt(0).toUpperCase() || '?'
}

function resetForms() {
  state.newContent = ''
  state.editingId = null
  state.editContent = ''
}

async function fetchComments() {
  state.loading++
  try {
    state.comments = await API_CLIENT.get(
      `sites/${siteStore.id}/pages/${pageStore.id}/comments`
    ).json()
  } catch (err) {
    // -> A thread that will not load is worth saying so about, but it must not take the page with it
    state.comments = []
    notify({ type: 'negative', message: apiErrorMessage(err, t('common.error.unexpected')) })
  }
  state.loading--
}

async function postComment() {
  const content = state.newContent.trim()
  if (content.length < 1) {
    notify({ type: 'warning', message: t('common.comments.contentMissingError') })
    return
  }
  if (!userStore.authenticated && !(await newForm.value.validate(true))) {
    return
  }
  state.saving = true
  try {
    const resp = await API_CLIENT.post(`sites/${siteStore.id}/pages/${pageStore.id}/comments`, {
      json: {
        content,
        ...(userStore.authenticated
          ? {}
          : { guestName: state.guestName.trim(), guestEmail: state.guestEmail.trim() })
      }
    }).json()
    // -> Appended rather than refetched: the thread is oldest first, so a new comment goes at the end
    state.comments.push(resp.comment)
    state.newContent = ''
    notify({ type: 'positive', message: t('common.comments.postSuccess') })
  } catch (err) {
    notify({ type: 'negative', message: apiErrorMessage(err, t('common.error.unexpected')) })
  }
  state.saving = false
}

function startEdit(comment) {
  state.editingId = comment.id
  state.editContent = comment.content
}

function cancelEdit() {
  state.editingId = null
  state.editContent = ''
}

async function saveEdit() {
  const content = state.editContent.trim()
  if (content.length < 1) {
    notify({ type: 'warning', message: t('common.comments.contentMissingError') })
    return
  }
  state.saving = true
  try {
    const resp = await API_CLIENT.patch(`sites/${siteStore.id}/comments/${state.editingId}`, {
      json: { content }
    }).json()
    const idx = state.comments.findIndex((c) => c.id === state.editingId)
    if (idx >= 0) {
      state.comments[idx] = resp.comment
    }
    cancelEdit()
    notify({ type: 'positive', message: t('common.comments.updateSuccess') })
  } catch (err) {
    notify({ type: 'negative', message: apiErrorMessage(err, t('common.error.unexpected')) })
  }
  state.saving = false
}

function removeComment(comment) {
  confirm({
    title: t('common.comments.deleteConfirmTitle'),
    message: `${t('common.comments.deleteWarn')} ${t('common.comments.deletePermanentWarn')}`,
    cancel: true,
    okColor: 'negative',
    okLabel: t('common.actions.delete')
  }).onOk(async () => {
    try {
      await API_CLIENT.delete(`sites/${siteStore.id}/comments/${comment.id}`)
      state.comments = state.comments.filter((c) => c.id !== comment.id)
      notify({ type: 'positive', message: t('common.comments.deleteSuccess') })
    } catch (err) {
      notify({ type: 'negative', message: apiErrorMessage(err, t('common.error.unexpected')) })
    }
  })
}
</script>

<style lang="scss">
/*
  The comment body reuses none of the page content classes: a comment is a paragraph and a list, not an
  article, and `page-contents` carries heading sizes, anchors and code-block chrome that would make one
  comment louder than the page above it. So this is the small amount of typography a thread needs.
*/
.page-comment-body {
  font-size: 0.875rem;
  line-height: 1.5;
  word-break: break-word;

  p {
    margin: 0.25rem 0;
  }

  ul,
  ol {
    margin: 0.25rem 0;
    padding-left: 1.25rem;
    list-style: revert;
  }

  blockquote {
    margin: 0.25rem 0;
    padding-left: 0.75rem;
    border-left: 3px solid rgba(0, 0, 0, 0.12);
    color: rgba(0, 0, 0, 0.6);

    .body--dark & {
      border-left-color: rgba(255, 255, 255, 0.18);
      color: rgba(255, 255, 255, 0.7);
    }
  }

  code {
    padding: 0.1rem 0.25rem;
    border-radius: 3px;
    background-color: rgba(0, 0, 0, 0.06);
    font-size: 0.8125rem;

    .body--dark & {
      background-color: rgba(255, 255, 255, 0.1);
    }
  }

  pre {
    margin: 0.25rem 0;
    padding: 0.5rem;
    overflow-x: auto;
    border-radius: 4px;
    background-color: rgba(0, 0, 0, 0.06);

    code {
      padding: 0;
      background: none;
    }

    .body--dark & {
      background-color: rgba(255, 255, 255, 0.08);
    }
  }

  a {
    color: $primary;
    text-decoration: underline;
  }
}
</style>
