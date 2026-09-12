<template>
  <div class="wysiwyg-container">
    <div class="wysiwyg-toolbar" v-if="editor">
      <template v-for="menuItem of menuBar">
        <w-separator class="mx-1" v-if="menuItem.type === `divider`" vertical />
        <w-btn
          v-else-if="menuItem.type === `dropdown`"
          :key="`ddn-` + menuItem.key"
          flat
          :icon="menuItem.icon"
          padding="xs"
          :class='{ "is-active": menuItem.isActive && menuItem.isActive() }'
          :color="menuItem.isActive && menuItem.isActive() ? `primary` : `grey-10`"
          :aria-label="menuItem.title"
          split
          :disabled="menuItem.disabled && menuItem.disabled()">
          <w-menu>
            <w-list dense padding>
              <template v-for="child of menuItem.children">
                <w-separator class="my-2" v-if="child.type === `divider`" />
                <w-item
                  v-else
                  :key="child.key"
                  clickable
                  @click="child.action"
                  :active="child.isActive && child.isActive()"
                  active-class="text-primary"
                  :disabled="child.disabled && child.disabled()">
                  <w-item-section side>
                    <w-icon :name="child.icon" :color="child.color" />
                  </w-item-section>
                  <w-item-section><w-item-label>{{child.title}}</w-item-label></w-item-section>
                </w-item>
              </template>
            </w-list>
          </w-menu>
        </w-btn>
        <w-btn-group v-else-if="menuItem.type === `btngroup`" :key="`btngrp-` + menuItem.key" flat>
          <w-btn
            v-for="child of menuItem.children"
            :key="child.key"
            flat
            :icon="child.icon"
            padding="xs"
            :class='{ "is-active": child.isActive && child.isActive() }'
            :color="child.isActive && child.isActive() ? `primary` : `grey-10`"
            @click="child.action"
            :aria-label="child.title"
            :disabled="menuItem.disabled && menuItem.disabled()" />
        </w-btn-group>
        <w-btn
          v-else
          :key="`btn-` + menuItem.key"
          flat
          :icon="menuItem.icon"
          padding="xs"
          :class='{ "is-active": menuItem.isActive && menuItem.isActive() }'
          :color="menuItem.isActive && menuItem.isActive() ? `primary` : `grey-10`"
          @click="menuItem.action"
          :aria-label="menuItem.title"
          :disabled="menuItem.disabled && menuItem.disabled()" />
      </template>
      <!-- q-space -->
      <!-- q-btn( -->
      <!-- size='sm' -->
      <!-- unelevated -->
      <!-- color='red' -->
      <!-- label='Test' -->
      <!-- @click='snapshot' -->
      <!-- ) -->
    </div>
    <!-- q-scroll-area( -->
    <!-- :thumb-style='thumbStyle' -->
    <!-- :bar-style='barStyle' -->
    <!-- style='height: 100%;' -->
    <!-- ) -->
    <editor-content :editor="editor" />
  </div>
</template>

<script setup>
/**
 * The WYSIWYG editor.
 *
 * **Replacing it.** Everything that knows this editor exists is a registration, and every one of them
 * names it `wysiwyg` rather than naming what it is built on:
 *
 *   - `pages/Index.vue` -- the async loader in `editorComponents`, which is the only import of this
 *     file anywhere.
 *   - `backend/api/schemas/site.ts` -- the `wysiwyg` block of the editors config, and the toggle
 *     `AdminEditors.vue` draws from it.
 *
 * **Why it is behind the experimental flag.** Not because it does not work. `EDITOR_CONTENT_TYPES`
 * says a page written here is stored as HTML, and a storage target laying content out by path writes
 * that source verbatim -- so this page reaches a git mirror as `<path>.html` while every markdown page
 * arrives as `<path>.md`. Choosing this editor therefore takes a page out of the markdown corpus, which
 * is a decision about the wiki's content rather than about which toolbar somebody prefers. The flag is
 * what keeps it deliberate until its owner has made that call.
 *   - `backend/models/pages.ts` -- `EDITOR_CONTENT_TYPES.wysiwyg`, which says a page written here is
 *     stored as HTML.
 *
 * Swapping in another one is therefore: point that loader at the replacement, and keep the contract
 * this file holds up -- read `pageStore.content` on open, write `content` and `render` on every
 * change, set `contentLoaded`, and answer the two editor-agnostic events below. Nothing outside this
 * file mentions TipTap, so nothing else has to be unpicked.
 *
 * **The contract, in full.**
 *   - `pageStore.content` is the page's source and `pageStore.render` is the HTML a reader is served.
 *     Both are HTML here, and both are the same string: what the author sees IS the render, so there
 *     is no second pipeline that could disagree with the first. The server sanitizes `render` on the
 *     way in -- see `postProcess` in `backend/models/rendering.ts` -- which is what makes it safe to
 *     let a browser decide what the HTML is.
 *   - `insertAsset` (in) -- the File Manager picked something; see `insertAssetClb`.
 *   - `reloadEditorContent` (in) -- pasted files have been uploaded and their `blob:` URLs now have
 *     real paths; see `reloadEditorContent`.
 */
import { onBeforeUnmount, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'

import { dialog } from '@/composables/dialog'
import { notify } from '@/composables/notify'
import {
  assetPath,
  assetUrl,
  fileSrc,
  rewriteHtmlImages,
  unresolveHtmlImages
} from '@/helpers/assets'
import { isExternalHref } from '@/helpers/links'

import { useEditorStore } from '@/stores/editor'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'

import LinkPickerDialog from '@/components/LinkPickerDialog.vue'

import { useEditor, EditorContent } from '@tiptap/vue-3'
import StarterKit from '@tiptap/starter-kit'
import Highlight from '@tiptap/extension-highlight'
import Image from '@tiptap/extension-image'
import TextAlign from '@tiptap/extension-text-align'
import { Color, FontFamily, TextStyle } from '@tiptap/extension-text-style'
import { TableKit } from '@tiptap/extension-table'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { Placeholder } from '@tiptap/extensions'

// STORES

const editorStore = useEditorStore()
const pageStore = usePageStore()
const siteStore = useSiteStore()

// I18N

const { t } = useI18n()

// STATE

/**
 * The TipTap instance, as a ref rather than a plain value: `useEditor` hands back a `ShallowRef` and
 * re-renders this component on every transaction, which is what keeps the toolbar's active states in
 * step with where the caret is.
 */
let editor = null

/**
 * What a link may be addressed with. Anything with no scheme at all is a path in this wiki and is
 * allowed; anything else has to be one of these.
 *
 * The same set the server keeps -- `ALLOWED_SCHEMES` in `backend/models/rendering.ts` -- because the
 * server is what decides, and accepting an address that will be thrown away is worse than refusing it.
 */
const ALLOWED_SCHEMES = new Set(['http', 'https', 'mailto', 'tel', 'ftp'])

const menuBar = [
  {
    key: 'bold',
    icon: 'mdi:format-bold',
    title: 'Bold',
    action: () => editor.value.chain().focus().toggleBold().run(),
    isActive: () => editor.value.isActive('bold')
  },
  {
    key: 'italic',
    icon: 'mdi:format-italic',
    title: 'Italic',
    action: () => editor.value.chain().focus().toggleItalic().run(),
    isActive: () => editor.value.isActive('italic')
  },
  {
    key: 'strikethrough',
    icon: 'mdi:format-strikethrough',
    title: 'Strike',
    action: () => editor.value.chain().focus().toggleStrike().run(),
    isActive: () => editor.value.isActive('strike')
  },
  {
    key: 'code',
    icon: 'mdi:code-tags',
    title: 'Code',
    action: () => editor.value.chain().focus().toggleCode().run(),
    isActive: () => editor.value.isActive('code')
  },
  {
    key: 'fontfamily',
    icon: 'mdi:format-font',
    title: 'Font Family',
    type: 'dropdown',
    isActive: () => editor.value.isActive('fontFamily'),
    children: [
      {
        key: 'fontunset',
        icon: 'mdi:format-font',
        title: 'Sans-Serif',
        action: () => editor.value.chain().focus().unsetFontFamily().run()
      },
      {
        key: 'monospace',
        icon: 'mdi:format-font',
        title: 'Monospace',
        action: () => editor.value.chain().focus().setFontFamily('monospace').run()
      }
    ]
  },
  {
    key: 'color',
    icon: 'mdi:palette',
    title: 'Text Color',
    type: 'dropdown',
    isActive: () => editor.value.isActive('textStyle'),
    children: [
      {
        key: 'color-blue',
        icon: 'mdi:palette',
        title: 'Blue',
        color: 'blue',
        action: () => editor.value.chain().focus().setColor('blue').run()
      },
      {
        key: 'color-brown',
        icon: 'mdi:palette',
        title: 'Brown',
        color: 'brown',
        action: () => editor.value.chain().focus().setColor('brown').run()
      },
      {
        key: 'color-green',
        icon: 'mdi:palette',
        title: 'Green',
        color: 'green',
        action: () => editor.value.chain().focus().setColor('green').run()
      },
      {
        key: 'color-orange',
        icon: 'mdi:palette',
        title: 'Orange',
        color: 'orange',
        action: () => editor.value.chain().focus().setColor('orange').run()
      },
      {
        key: 'color-pink',
        icon: 'mdi:palette',
        title: 'Pink',
        color: 'pink',
        action: () => editor.value.chain().focus().setColor('pink').run()
      },
      {
        key: 'color-purple',
        icon: 'mdi:palette',
        title: 'Purple',
        color: 'purple',
        action: () => editor.value.chain().focus().setColor('purple').run()
      },
      {
        key: 'color-red',
        icon: 'mdi:palette',
        title: 'Red',
        color: 'red',
        action: () => editor.value.chain().focus().setColor('red').run()
      },
      {
        key: 'color-teal',
        icon: 'mdi:palette',
        title: 'Teal',
        color: 'teal',
        action: () => editor.value.chain().focus().setColor('teal').run()
      },
      {
        key: 'color-yellow',
        icon: 'mdi:palette',
        title: 'Yellow',
        color: 'yellow',
        action: () => editor.value.chain().focus().setColor('yellow').run()
      },
      {
        type: 'divider'
      },
      {
        key: 'color-remove',
        icon: 'mdi:palette',
        title: 'Default',
        color: 'grey',
        action: () => editor.value.chain().focus().unsetColor().run()
      }
    ]
  },
  {
    key: 'highlight',
    icon: 'mdi:marker',
    title: 'Highlight',
    type: 'dropdown',
    isActive: () => editor.value.isActive('highlight'),
    children: [
      {
        key: 'highlight-yellow',
        icon: 'mdi:marker',
        title: 'Yellow',
        color: 'yellow',
        action: () => editor.value.chain().focus().toggleHighlight({ color: 'yellow' }).run()
      },
      {
        key: 'highlight-blue',
        icon: 'mdi:marker',
        title: 'Blue',
        color: 'blue',
        action: () => editor.value.chain().focus().toggleHighlight({ color: 'blue' }).run()
      },
      {
        key: 'highlight-pink',
        icon: 'mdi:marker',
        title: 'Pink',
        color: 'pink',
        action: () => editor.value.chain().focus().toggleHighlight({ color: 'pink' }).run()
      },
      {
        key: 'highlight-green',
        icon: 'mdi:marker',
        title: 'Green',
        color: 'green',
        action: () => editor.value.chain().focus().toggleHighlight({ color: 'green' }).run()
      },
      {
        key: 'highlight-orange',
        icon: 'mdi:marker',
        title: 'Orange',
        color: 'orange',
        action: () => editor.value.chain().focus().toggleHighlight({ color: 'orange' }).run()
      },
      {
        type: 'divider'
      },
      {
        key: 'highlight-remove',
        icon: 'mdi:marker-cancel',
        title: 'Remove',
        color: 'grey',
        action: () => editor.value.chain().focus().unsetHighlight().run()
      }
    ]
  },
  {
    type: 'divider'
  },
  {
    key: 'header',
    icon: 'mdi:format-header-pound',
    title: 'Header',
    type: 'dropdown',
    isActive: () => editor.value.isActive('heading'),
    children: [
      {
        key: 'h1',
        icon: 'mdi:format-header-1',
        title: 'Header 1',
        action: () => editor.value.chain().focus().toggleHeading({ level: 1 }).run(),
        isActive: () => editor.value.isActive('heading', { level: 1 })
      },
      {
        key: 'h2',
        icon: 'mdi:format-header-2',
        title: 'Header 2',
        action: () => editor.value.chain().focus().toggleHeading({ level: 2 }).run(),
        isActive: () => editor.value.isActive('heading', { level: 2 })
      },
      {
        key: 'h3',
        icon: 'mdi:format-header-3',
        title: 'Header 3',
        action: () => editor.value.chain().focus().toggleHeading({ level: 3 }).run(),
        isActive: () => editor.value.isActive('heading', { level: 3 })
      },
      {
        key: 'h4',
        icon: 'mdi:format-header-4',
        title: 'Header 4',
        action: () => editor.value.chain().focus().toggleHeading({ level: 4 }).run(),
        isActive: () => editor.value.isActive('heading', { level: 4 })
      },
      {
        key: 'h5',
        icon: 'mdi:format-header-5',
        title: 'Header 5',
        action: () => editor.value.chain().focus().toggleHeading({ level: 5 }).run(),
        isActive: () => editor.value.isActive('heading', { level: 5 })
      },
      {
        key: 'h6',
        icon: 'mdi:format-header-6',
        title: 'Header 6',
        action: () => editor.value.chain().focus().toggleHeading({ level: 6 }).run(),
        isActive: () => editor.value.isActive('heading', { level: 6 })
      }
    ]
  },
  {
    key: 'paragraph',
    icon: 'mdi:format-paragraph',
    title: 'Paragraph',
    action: () => editor.value.chain().focus().setParagraph().run(),
    isActive: () => editor.value.isActive('paragraph')
  },
  {
    type: 'divider'
  },
  {
    key: 'align',
    type: 'btngroup',
    children: [
      {
        key: 'align-left',
        icon: 'mdi:format-align-left',
        title: 'Left Align',
        action: () => editor.value.chain().focus().setTextAlign('left').run(),
        isActive: () => editor.value.isActive({ textAlign: 'left' })
      },
      {
        key: 'align-center',
        icon: 'mdi:format-align-center',
        title: 'Center Align',
        action: () => editor.value.chain().focus().setTextAlign('center').run(),
        isActive: () => editor.value.isActive({ textAlign: 'center' })
      },
      {
        key: 'align-right',
        icon: 'mdi:format-align-right',
        title: 'Right Align',
        action: () => editor.value.chain().focus().setTextAlign('right').run(),
        isActive: () => editor.value.isActive({ textAlign: 'right' })
      },
      {
        key: 'align-justify',
        icon: 'mdi:format-align-justify',
        title: 'Justify Align',
        action: () => editor.value.chain().focus().setTextAlign('justify').run(),
        isActive: () => editor.value.isActive({ textAlign: 'justify' })
      }
    ]
  },
  {
    type: 'divider'
  },
  {
    key: 'bulletlist',
    icon: 'mdi:format-list-bulleted',
    title: 'Bullet List',
    action: () => editor.value.chain().focus().toggleBulletList().run(),
    isActive: () => editor.value.isActive('bulletList')
  },
  {
    key: 'orderedlist',
    icon: 'mdi:format-list-numbered',
    title: 'Ordered List',
    action: () => editor.value.chain().focus().toggleOrderedList().run(),
    isActive: () => editor.value.isActive('orderedList')
  },
  {
    key: 'tasklist',
    icon: 'mdi:format-list-checks',
    title: 'Task List',
    action: () => editor.value.chain().focus().toggleTaskList().run(),
    isActive: () => editor.value.isActive('taskList')
  },
  {
    type: 'divider'
  },
  {
    key: 'codeblock',
    icon: 'mdi:code-json',
    title: 'Code Block',
    action: () => editor.value.chain().focus().toggleCodeBlock().run(),
    isActive: () => editor.value.isActive('codeBlock')
  },
  {
    key: 'blockquote',
    icon: 'mdi:format-quote-open',
    title: 'Blockquote',
    action: () => editor.value.chain().focus().toggleBlockquote().run(),
    isActive: () => editor.value.isActive('blockquote')
  },
  {
    key: 'rule',
    icon: 'mdi:minus',
    title: 'Horizontal Rule',
    action: () => editor.value.chain().focus().setHorizontalRule().run()
  },
  {
    key: 'link',
    icon: 'mdi:link-variant',
    title: 'Link',
    action: () => editLink(),
    isActive: () => editor.value.isActive('link')
  },
  // -> Its own button because the picker cannot express it: every answer it gives is an address, so
  //    "no link" is not among them, and an author who wants one gone has nothing else to reach for
  {
    key: 'linkremove',
    icon: 'mdi:link-variant-off',
    title: 'Remove Link',
    action: () => editor.value.chain().focus().extendMarkRange('link').unsetLink().run(),
    disabled: () => !editor.value.isActive('link')
  },
  {
    key: 'image',
    icon: 'mdi:image-plus',
    title: 'Image',
    action: () => siteStore.openFileManager({ insertMode: true })
  },
  {
    key: 'table',
    icon: 'mdi:table',
    title: 'Table',
    type: 'dropdown',
    isActive: () => editor.value.isActive('table'),
    children: [
      {
        key: 'table-insert',
        icon: 'mdi:table-large-plus',
        title: 'Insert Table',
        action: () =>
          editor.value.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
      },
      {
        type: 'divider'
      },
      {
        key: 'table-addcolumnbefore',
        icon: 'mdi:table-column-plus-before',
        title: 'Add Column Before',
        action: () => editor.value.chain().focus().addColumnBefore().run(),
        disabled: () => !editor.value.can().addColumnBefore()
      },
      {
        key: 'table-addcolumnafter',
        icon: 'mdi:table-column-plus-after',
        title: 'Add Column After',
        action: () => editor.value.chain().focus().addColumnAfter().run(),
        disabled: () => !editor.value.can().addColumnAfter()
      },
      {
        key: 'table-deletecolumn',
        icon: 'mdi:table-column-remove',
        title: 'Remove Column',
        action: () => editor.value.chain().focus().deleteColumn().run(),
        disabled: () => !editor.value.can().deleteColumn()
      },
      {
        type: 'divider'
      },
      {
        key: 'table-addrowbefore',
        icon: 'mdi:table-row-plus-before',
        title: 'Add Row Before',
        action: () => editor.value.chain().focus().addRowBefore().run(),
        disabled: () => !editor.value.can().addRowBefore()
      },
      {
        key: 'table-addrowafter',
        icon: 'mdi:table-row-plus-after',
        title: 'Add Row After',
        action: () => editor.value.chain().focus().addRowAfter().run(),
        disabled: () => !editor.value.can().addRowAfter()
      },
      {
        key: 'table-deleterow',
        icon: 'mdi:table-row-remove',
        title: 'Remove Row',
        action: () => editor.value.chain().focus().deleteRow().run(),
        disabled: () => !editor.value.can().deleteRow()
      },
      {
        type: 'divider'
      },
      {
        key: 'table-merge',
        icon: 'mdi:table-merge-cells',
        title: 'Merge Cells',
        action: () => editor.value.chain().focus().mergeCells().run(),
        disabled: () => !editor.value.can().mergeCells()
      },
      {
        key: 'table-split',
        icon: 'mdi:table-split-cell',
        title: 'Split Cell',
        action: () => editor.value.chain().focus().splitCell().run(),
        disabled: () => !editor.value.can().splitCell()
      },
      {
        type: 'divider'
      },
      {
        key: 'table-toggleHeaderColumn',
        icon: 'mdi:table-column',
        title: 'Toggle Header Column',
        action: () => editor.value.chain().focus().toggleHeaderColumn().run(),
        disabled: () => !editor.value.can().toggleHeaderColumn()
      },
      {
        key: 'table-toggleHeaderRow',
        icon: 'mdi:table-row',
        title: 'Toggle Header Row',
        action: () => editor.value.chain().focus().toggleHeaderRow().run(),
        disabled: () => !editor.value.can().toggleHeaderRow()
      },
      {
        key: 'table-toggleHeaderCell',
        icon: 'mdi:crop-square',
        title: 'Toggle Header Cell',
        action: () => editor.value.chain().focus().toggleHeaderCell().run(),
        disabled: () => !editor.value.can().toggleHeaderCell()
      },
      {
        type: 'divider'
      },
      {
        key: 'table-fix',
        icon: 'mdi:table-heart',
        title: 'Fix Table',
        action: () => editor.value.chain().focus().fixTables().run(),
        disabled: () => !editor.value.can().fixTables()
      },
      {
        key: 'table-remove',
        icon: 'mdi:table-large-remove',
        title: 'Delete Table',
        action: () => editor.value.chain().focus().deleteTable().run(),
        disabled: () => !editor.value.can().deleteTable()
      }
    ]
  },
  {
    type: 'divider'
  },
  {
    key: 'pagebreak',
    icon: 'mdi:format-page-break',
    title: 'Hard Break',
    action: () => editor.value.chain().focus().setHardBreak().run()
  },
  {
    key: 'clearformat',
    icon: 'mdi:format-clear',
    title: 'Clear Format',
    action: () => editor.value.chain().focus().clearNodes().unsetAllMarks().run()
  },
  {
    type: 'divider'
  },
  {
    key: 'undo',
    icon: 'mdi:undo-variant',
    title: 'Undo',
    action: () => editor.value.chain().focus().undo().run(),
    disabled: () => !editor.value.can().undo()
  },
  {
    key: 'redo',
    icon: 'mdi:redo-variant',
    title: 'Redo',
    action: () => editor.value.chain().focus().redo().run(),
    disabled: () => !editor.value.can().redo()
  }
]

// METHODS

function init() {
  // -> Setup Editor View
  editorStore.$patch({
    hideSideNav: false
  })

  editor = useEditor({
    /*
      HTML in, HTML out.

      `EDITOR_CONTENT_TYPES.wysiwyg` in `backend/models/pages.ts` says a page written here is stored
      as HTML, and this is what has to be true for that to mean anything: the source is the document,
      not a serialization of whichever editor happened to write it. It is also what keeps this
      replaceable -- a page authored here opens in the next editor, and reads as a page in an export,
      rather than as a JSON blob only TipTap can make sense of.

      Resolved on the way in, because this editor's surface IS the render and a source path is not a
      URL that loads -- see `syncToStore` for the way back out.
    */
    content: rewriteHtmlImages(pageStore.content ?? '', pageStore.path),
    extensions: [
      StarterKit.configure({
        // -> Named `history` before TipTap 3
        undoRedo: {
          depth: 500
        },
        /*
          Where the link toolbar button and the page picker put them, and nowhere else. Autolinking
          rewrites what the author typed as they type it, and pasting a URL over selected text is
          reasonably often meant as replacing the text.
        */
        link: {
          autolink: false,
          linkOnPaste: false,
          openOnClick: false,
          // -> Emptied: the extension puts `target="_blank"` and a `nofollow` on EVERY link, and a
          //    link to another page in this wiki is neither. `linkAttrs` decides per link.
          HTMLAttributes: {}
        }
      }),
      Color,
      FontFamily,
      Highlight.configure({
        multicolor: true
      }),
      Image,
      Placeholder.configure({
        placeholder: 'Enter some content here...'
      }),
      TableKit.configure({
        table: { resizable: true }
      }),
      TaskList,
      TaskItem,
      TextAlign,
      TextStyle
    ],
    editorProps: {
      handlePaste,
      handleDrop
    },
    onUpdate: ({ editor }) => {
      syncToStore(editor)
    }
  })
}

/**
 * The editor's document onto the page store: the source a save sends, and the render made from it.
 *
 * The two are the same HTML but for where the pictures point. A page's source addresses an uploaded
 * file the way a file beside it would -- `/photo.png` -- and that is deliberately not a URL this
 * server answers; `/_files/` is. The document on screen has to draw the picture, so it holds the URL,
 * and the source is what that URL came from. Same bargain the markdown pipeline strikes, same pair of
 * functions striking it.
 */
function syncToStore(instance) {
  const html = instance.getHTML()
  editorStore.$patch({
    lastChangeTimestamp: Temporal.Now.instant()
  })
  pageStore.$patch({
    content: unresolveHtmlImages(html),
    // -> What the author has typed IS the source, whatever the load did or did not deliver; see
    //    the guard in `pageSave`
    contentLoaded: true,
    render: html
  })
}

/**
 * Put a link on the selection, or re-point the one already there.
 *
 * The picker is the markdown editor's own -- it browses the page tree on one tab and takes any address
 * on the other -- so a link is chosen the same way in both editors, and this file holds no opinion
 * about how you find a page.
 */
function editLink() {
  const instance = editor.value
  // -> A caret with no selection and no link under it has nothing to make into a link, so the words
  //    have to come from somewhere; see the fallback below
  const needsText = instance.state.selection.empty && !instance.isActive('link')
  dialog({
    component: LinkPickerDialog,
    componentProps: {
      initialHref: instance.getAttributes('link').href ?? '',
      // -> Whether a link opens in a new tab is decided by where it points, not asked per link --
      //    see `linkAttrs` -- so the checkbox would be a control whose answer is discarded
      newTabOption: false
    }
  }).onOk(({ href, title }) => {
    /*
      Refused here rather than swallowed later. The picker's URL tab takes any address, the link
      extension then drops one it will not open while keeping the mark, and the server's sanitizer
      drops the attribute on the way in -- so a `javascript:` link became an `<a>` pointing at nothing,
      with no word said about it to the author.
    */
    const scheme = /^([a-z][a-z\d+.-]*):/i.exec(href)?.[1]
    if (scheme && !ALLOWED_SCHEMES.has(scheme.toLowerCase())) {
      notify({
        type: 'negative',
        message: t('editor.wysiwyg.linkUrlScheme', { scheme })
      })
      return
    }
    const chain = instance.chain().focus()
    if (needsText) {
      // -> The page's own title where a page was picked and the address itself otherwise, which is
      //    what a bare URL on a line means. The same fallback the markdown editor's link button uses.
      insertLinkText(chain, href, title || href)
      return
    }
    /*
      Marking what is there rather than re-inserting it: a selection carries its own formatting, and
      writing the same words back as plain text would drop the bold off a linked phrase.
      `extendMarkRange` is what makes a caret sitting inside a link re-point the whole link instead of
      splitting it.
    */
    chain.extendMarkRange('link').setLink(linkAttrs(href)).run()
  })
}

/**
 * What the File Manager handed back, at the cursor.
 *
 * Both kinds go in as paths from the site root: a file through `assetPath`, and a page the way the
 * link picker writes one. An image goes in as one and anything else as a link -- a PDF picked from
 * the File Manager is a link to a PDF, not a broken picture -- which is the same distinction
 * `insertFiles` draws for a file that arrives by drop, and the same one `EditorMarkdown` draws.
 */
function insertAssetClb(opts) {
  const chain = editor.value.chain().focus()
  switch (opts.type) {
    case 'asset': {
      if (opts.mimeType?.startsWith('image/')) {
        // -> The URL it loads from, not the path the page stores; `syncToStore` puts that back
        chain.setImage({ src: assetUrl(opts.folderPath, opts.fileName), alt: opts.title }).run()
      } else {
        // -> A link is stored as written and resolved by nobody, here or in markdown, so it is the
        //    path that goes in
        insertLinkText(chain, assetPath(opts.folderPath, opts.fileName), opts.title)
      }
      break
    }
    case 'page': {
      const pagePath = opts.folderPath ? `${opts.folderPath}/${opts.fileName}` : opts.fileName
      insertLinkText(chain, `/${pagePath}`, opts.title)
      break
    }
  }
}

/** A piece of linked text at the cursor, with the link mark closed off behind it. */
function insertLinkText(chain, href, text) {
  chain
    .insertContent({ type: 'text', text, marks: [{ type: 'link', attrs: linkAttrs(href) }] })
    .unsetMark('link')
    .run()
}

/**
 * How a link is written, which depends on where it goes.
 *
 * A link that leaves the wiki opens in a new tab and disclaims itself, as the markdown pipeline marks
 * one; a link to another page in this wiki does neither -- it is the reader following the wiki, and
 * the router follows it in place.
 */
function linkAttrs(href) {
  // -> Both keys either way, so that re-pointing an external link at a page CLEARS them rather than
  //    leaving the old ones merged in underneath
  return isExternalHref(href)
    ? { href, target: '_blank', rel: 'noopener noreferrer nofollow' }
    : { href, target: null, rel: null }
}

/**
 * Files pasted or dropped into the editor.
 *
 * Nothing is uploaded here. Each one becomes a pending asset held against a `blob:` URL that the
 * document points at, and `UploadPendingAssetsDialog` sends them on save and rewrites those URLs to
 * wherever they actually landed -- see `reloadEditorContent`. So the editor shows the image
 * immediately and the page never stores a URL that dies with the tab.
 *
 * Except while suggesting an edit, where files are refused outright: somebody suggesting an edit is
 * by definition somebody without write access to this page, and filing their files into the wiki
 * beside it is not a decision this flow gets to make. Said out loud rather than silently, because the
 * paste has already been taken off the browser by the time this runs.
 */
function insertFiles(files) {
  if (editorStore.mode === 'suggest') {
    notify({
      type: 'warning',
      message: t('editor.pendingAssetsNotInSuggestions')
    })
    return
  }
  const chain = editor.value.chain().focus()
  for (const file of files) {
    const blobUrl = editorStore.addPendingAsset(file)
    if (file.type.startsWith('image/')) {
      chain.setImage({ src: blobUrl, alt: file.name })
    } else {
      chain.insertContent({
        type: 'text',
        text: file.name,
        marks: [{ type: 'link', attrs: linkAttrs(blobUrl) }]
      })
      chain.unsetMark('link')
    }
  }
  chain.run()
}

/*
  Pasting a file inserts it; pasting anything else is left to ProseMirror.

  Text wins when both are on the clipboard. Copying from a spreadsheet or a design tool puts a bitmap
  of the selection alongside the text, and pasting a picture of a table nobody asked for is worse than
  pasting the table.
*/
function handlePaste(view, event) {
  const files = [...(event.clipboardData?.files ?? [])]
  if (files.length === 0) {
    return false
  }
  if ((event.clipboardData.getData('text/plain') ?? '').trim().length > 0) {
    return false
  }
  insertFiles(files)
  // -> Claimed: ProseMirror's own handling would put the file's name in as text
  return true
}

function handleDrop(view, event) {
  const files = [...(event.dataTransfer?.files ?? [])]
  if (files.length === 0) {
    return false
  }
  // -> Dropped text lands where it was dropped, and so should a file: the caret moves to meet it
  const target = view.posAtCoords({ left: event.clientX, top: event.clientY })
  if (target) {
    editor.value.commands.setTextSelection(target.pos)
  }
  insertFiles(files)
  return true
}

/**
 * Point the document at the files a save has just uploaded, now that their `blob:` URLs have real
 * paths.
 *
 * Done as one transaction over the nodes that carry a URL rather than by putting the whole document
 * back with `setContent`. Replacing the document reads as "everything was deleted and everything was
 * typed again", which throws away the undo history and the caret for what is, to the author, an
 * upload finishing.
 *
 * The store follows immediately rather than on the next keystroke: this runs from
 * `UploadPendingAssetsDialog`, right before the save, and a `render` still full of `blob:` URLs is
 * what goes up if it does not.
 */
function reloadEditorContent({ replacements = [] } = {}) {
  const instance = editor.value
  if (!instance || replacements.length === 0) {
    return
  }
  const paths = new Map(replacements.map(({ from, to }) => [from, to]))
  const { state } = instance
  const tr = state.tr
  let changed = false
  state.doc.descendants((node, pos) => {
    if (node.type.name === 'image' && paths.has(node.attrs.src)) {
      // -> Through `fileSrc` for the same reason the load is: what the document holds is what loads
      tr.setNodeMarkup(pos, undefined, {
        ...node.attrs,
        src: fileSrc(paths.get(node.attrs.src), pageStore.path)
      })
      changed = true
    }
    for (const mark of node.marks) {
      if (mark.type.name === 'link' && paths.has(mark.attrs.href)) {
        // -> Through `linkAttrs` again: a `blob:` was never external and the path it becomes is not
        //    either, but the pair has one place where that is decided
        tr.addMark(
          pos,
          pos + node.nodeSize,
          mark.type.create({ ...mark.attrs, ...linkAttrs(paths.get(mark.attrs.href)) })
        )
        changed = true
      }
    }
  })
  if (changed) {
    instance.view.dispatch(tr)
  }
}

// MOUNTED

onMounted(() => {
  EVENT_BUS.on('insertAsset', insertAssetClb)
  EVENT_BUS.on('reloadEditorContent', reloadEditorContent)
})

// -> `useEditor` destroys the instance itself on unmount
onBeforeUnmount(() => {
  EVENT_BUS.off('insertAsset', insertAssetClb)
  EVENT_BUS.off('reloadEditorContent', reloadEditorContent)
})

init()
</script>

<style lang="scss">
.wysiwyg-container {
  height: calc(100% - 41px);

  .wysiwyg-toolbar {
    border: none;
    border-bottom: 1px solid $grey-4;
    display: flex;
    align-items: center;
    padding: 4px;
    background: linear-gradient(to top, $grey-1 0%, #fff 100%);
  }

  .ProseMirror {
    padding: 16px;
    min-height: 75vh;

    &-focused {
      border: none;
      outline: none;
    }

    > * + * {
      margin-top: 0.75em;
    }

    ul,
    ol {
      padding: 0 1rem;
    }

    h1,
    h2,
    h3,
    h4,
    h5,
    h6 {
      line-height: 1.1;
    }

    code {
      background-color: rgba(#616161, 0.1);
      color: #616161;
    }

    pre {
      background: #0d0d0d;
      color: #fff;
      font-family: 'JetBrainsMono', monospace;
      padding: 0.75rem 1rem;
      border-radius: 0.5rem;

      code {
        color: inherit;
        padding: 0;
        background: none;
        font-size: 0.8rem;
      }
    }

    img {
      max-width: 100%;
      height: auto;
    }

    blockquote {
      padding-left: 1rem;
      border-left: 2px solid rgba(#0d0d0d, 0.1);
    }

    hr {
      border: none;
      border-top: 2px solid rgba(#0d0d0d, 0.1);
      margin: 2rem 0;
    }

    table {
      border-collapse: collapse;
      table-layout: fixed;
      width: 100%;
      margin: 0;
      overflow: hidden;

      td,
      th {
        min-width: 1em;
        border: 2px solid #ced4da;
        padding: 3px 5px;
        vertical-align: top;
        box-sizing: border-box;
        position: relative;

        > * {
          margin-bottom: 0;
        }
      }

      th {
        font-weight: bold;
        text-align: left;
        background-color: #f1f3f5;
      }

      .selectedCell:after {
        z-index: 2;
        position: absolute;
        content: '';
        left: 0;
        right: 0;
        top: 0;
        bottom: 0;
        background: rgba(200, 200, 255, 0.4);
        pointer-events: none;
      }

      .column-resize-handle {
        position: absolute;
        right: -2px;
        top: 0;
        bottom: -2px;
        width: 4px;
        background-color: #adf;
        pointer-events: none;
      }
    }

    .tableWrapper {
      overflow-x: auto;
    }

    .resize-cursor {
      cursor: ew-resize;
      cursor: col-resize;
    }

    ul[data-type='taskList'] {
      list-style: none;
      padding: 0;

      li {
        display: flex;
        align-items: center;

        > label {
          flex: 0 0 auto;
          margin-right: 0.5rem;
        }
      }
    }

    p.is-editor-empty:first-child::before {
      content: attr(data-placeholder);
      float: left;
      color: #ced4da;
      pointer-events: none;
      height: 0;
    }
  }
}
</style>
