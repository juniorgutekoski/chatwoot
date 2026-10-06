<script setup>
import { ref, computed, watch, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import Icon from 'dashboard/components-next/icon/Icon.vue';
import WootWriter from 'dashboard/components/widgets/WootWriter/Editor.vue';
import AudioRecorder from 'dashboard/components/widgets/WootWriter/AudioRecorder.vue';
import { useAlert } from 'dashboard/composables';
import { useAccount } from 'dashboard/composables/useAccount';
import { FEATURE_FLAGS } from 'dashboard/featureFlags';
import { AUDIO_FORMATS } from 'shared/constants/messages';
import {
  splitFilesBySize,
  usableFilesFromTransfer,
} from 'dashboard/helper/pastedFiles';

const props = defineProps({
  disabled: {
    type: Boolean,
    default: false,
  },
  placeholder: {
    type: String,
    default: '',
  },
  initialContent: {
    type: String,
    default: '',
  },
  editingMessage: {
    type: Object,
    default: null,
  },
  showPoll: {
    type: Boolean,
    default: true,
  },
  showAlsoSendInChannel: {
    type: Boolean,
    default: false,
  },
});

const emit = defineEmits([
  'send',
  'typing',
  'draftUpdate',
  'createPoll',
  'cancelEdit',
]);

const alsoSendInChannel = ref(false);

const { t } = useI18n();
const { isCloudFeatureEnabled } = useAccount();

const editorRef = ref(null);
const fileInputRef = ref(null);
const editorContent = ref(props.initialContent);
const attachedFiles = ref([]);
const isMentionMenuOpen = ref(false);
const isConversationMenuOpen = ref(false);
const isDragging = ref(false);

const audioRecorderRef = ref(null);
const isRecorderOpen = ref(false);
// Empty until there is a recording to listen to, which covers both the capture running and
// the stop still being encoded; then 'stopped' | 'playing' | 'paused', the last two reported
// by the recorder itself.
const recordingState = ref('');
const recordingDuration = ref('00:00');
// The File the recorder produced, held apart from attachedFiles so discarding a
// recording can take out that one capture and leave clipped files alone.
const recordedFile = ref(null);
const sendWhenRecordingStops = ref(false);
// Set by the first progress tick, which is the only word we get that the microphone really
// opened. It outlives the capture on purpose: the encoder answers after the stop.
const micWasArmed = ref(false);

let draftTimer = null;
let dragCounter = 0;

// A voice note stays inside Chatwoot, so no channel decides the container: MP3 is
// the one format every browser and both mobile apps play back, which is the same
// reason the conversation composer picks it for a private note.
const audioRecordFormat = AUDIO_FORMATS.MP3;

const canRecordAudio =
  typeof window !== 'undefined' &&
  typeof window.MediaRecorder !== 'undefined' &&
  Boolean(navigator.mediaDevices?.getUserMedia);

// Not gated on `disabled`: that flips for the moment a message is being sent, and a
// microphone that blinks out of the toolbar on every send is worse than one that is
// there and briefly inert.
const showRecorderButton = computed(
  () => canRecordAudio && isCloudFeatureEnabled(FEATURE_FLAGS.VOICE_RECORDER)
);

const isCapturingAudio = computed(
  () => isRecorderOpen.value && !recordingState.value
);

const recorderPlayStopIcon = computed(() => {
  switch (recordingState.value) {
    case 'playing':
      return 'i-lucide-pause';
    case 'paused':
    case 'stopped':
      return 'i-lucide-play';
    default:
      return 'i-lucide-square';
  }
});

const canSend = computed(() => {
  if (props.disabled) return false;
  // While the microphone is capturing there is no file yet — the blob is only born
  // on stop — but the send button has to stay alive, because stopping and sending
  // is one gesture to the person holding it.
  if (isCapturingAudio.value) return true;
  return (
    editorContent.value.trim().length > 0 || attachedFiles.value.length > 0
  );
});

function cancelEdit() {
  editorContent.value = '';
  attachedFiles.value = [];
  recordedFile.value = null;
  closeRecorder();
  emit('cancelEdit');
}

watch(
  () => props.editingMessage,
  msg => {
    if (msg) {
      editorContent.value = msg.content || '';
    }
  },
  { immediate: true }
);

watch(editorContent, newContent => {
  if (draftTimer) clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    emit('draftUpdate', newContent);
  }, 3000);
});

function focusEditor() {
  editorRef.value?.$el?.querySelector('.ProseMirror')?.focus();
}

function insertMentionTrigger(char) {
  editorRef.value?.insertMentionTrigger?.(char);
}

function removeRecordedFile() {
  if (!recordedFile.value) return;
  const index = attachedFiles.value.indexOf(recordedFile.value);
  if (index !== -1) attachedFiles.value.splice(index, 1);
  recordedFile.value = null;
}

function closeRecorder() {
  isRecorderOpen.value = false;
  recordingState.value = '';
  recordingDuration.value = '00:00';
  sendWhenRecordingStops.value = false;
  micWasArmed.value = false;
}

function discardRecording() {
  removeRecordedFile();
  closeRecorder();
}

function toggleRecorder() {
  if (isRecorderOpen.value) {
    discardRecording();
    return;
  }
  recordingState.value = '';
  recordingDuration.value = '00:00';
  micWasArmed.value = false;
  isRecorderOpen.value = true;
}

// Whether the microphone is armed right now, asked of the recorder's own plugin rather
// than inferred from the panel being open: a refused permission leaves the panel open
// over a capture that never started, and a send must not wait for a blob that will
// never come.
function isMicrophoneCapturing() {
  return Boolean(audioRecorderRef.value?.record?.isRecording?.());
}

// Whether there is a capture to wait for at all — which is not the same question. Between
// the stop and the encoded file the microphone already reads as idle, so asking only the
// plugin would drop a note that is seconds away from arriving. The first progress tick is
// the proof the microphone opened; a refused permission never produces one.
function hasCaptureToWaitFor() {
  return isMicrophoneCapturing() || micWasArmed.value;
}

// One button, two jobs: it stops the capture while recording, and plays back what
// was recorded afterwards — the same pairing the conversation composer uses.
function toggleRecorderPlayPause() {
  if (!audioRecorderRef.value) return;
  if (isCapturingAudio.value) {
    audioRecorderRef.value.stopRecording();
    return;
  }
  audioRecorderRef.value.playPause();
}

function onRecordProgress(duration) {
  micWasArmed.value = true;
  recordingDuration.value = duration;
}

function onFinishRecord(recording) {
  // Encoding a long note takes seconds, so the capture can land after the person
  // already threw it away. Attaching it then would hide it twice over — the recorder
  // is closed and the strip filters the recording out — and it would ride along with
  // whatever they send next.
  if (!isRecorderOpen.value) return;

  recordingState.value = 'stopped';

  const file = recording?.file;
  if (!file) return;

  recordedFile.value = file;
  attachedFiles.value = [...attachedFiles.value, file];

  if (sendWhenRecordingStops.value) {
    sendWhenRecordingStops.value = false;
    handleSend();
  }
}

function onRecordError(payload) {
  discardRecording();
  // Being refused the microphone and losing the recording in the encoder are different
  // accidents, and only one of them is worth checking a permission over.
  useAlert(
    payload?.stage === 'start'
      ? t('INTERNAL_CHAT.MESSAGE.MICROPHONE_UNAVAILABLE')
      : t('INTERNAL_CHAT.MESSAGE.AUDIO_CONVERSION_FAILED')
  );
}

function handleSend() {
  if (!canSend.value) return;
  // Sending over an open recorder stops the microphone and waits: the file arrives in
  // onFinishRecord, which calls back here with the note already attached. This covers
  // both the capture still running and the one already stopped but still encoding.
  if (isCapturingAudio.value && hasCaptureToWaitFor()) {
    sendWhenRecordingStops.value = true;
    audioRecorderRef.value?.stopRecording();
    return;
  }
  const content = editorContent.value.trim();
  const files = [...attachedFiles.value];
  // The send button stays alive while the recorder is open, so this is the floor that
  // keeps a capture that never started from sending an empty message.
  if (!content && !files.length) {
    closeRecorder();
    return;
  }
  editorContent.value = '';
  attachedFiles.value = [];
  recordedFile.value = null;
  closeRecorder();
  if (draftTimer) {
    clearTimeout(draftTimer);
    draftTimer = null;
  }
  emit('draftUpdate', '');
  emit('send', content, {
    alsoSendInChannel: alsoSendInChannel.value,
    files,
  });
  setTimeout(() => focusEditor(), 200);
}

function handleToggleUserMention(isOpen) {
  isMentionMenuOpen.value = isOpen;
}

function handleToggleConversationMention(isOpen) {
  isConversationMenuOpen.value = isOpen;
}

function handleKeyDown(event) {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    if (isMentionMenuOpen.value || isConversationMenuOpen.value) return;
    event.preventDefault();
    event.stopPropagation();
    handleSend();
    return;
  }
  if (event.key === 'Escape' && isRecorderOpen.value) {
    event.preventDefault();
    discardRecording();
    return;
  }
  if (event.key === 'Escape' && props.editingMessage) {
    cancelEdit();
  }
}

function handleTypingOn() {
  emit('typing');
}

function openFilePicker() {
  fileInputRef.value?.click();
}

function handleFileChange(event) {
  // A file chosen in the picker was chosen on purpose, so an empty one is always worth a word:
  // there is no rich-copy artifact to confuse it with, and this was the one path that attached
  // a zero-byte file and let the send carry it (internal chat builds attachments outside
  // Messages::MessageBuilder, so nothing refuses it on the server either).
  const { files, empty } = splitFilesBySize(event.target.files);
  if (empty.length) useAlert(t('CONVERSATION.FILE_IS_EMPTY'));

  attachedFiles.value = [...attachedFiles.value, ...files];
  if (fileInputRef.value) fileInputRef.value.value = '';
}

// The recording has the recorder's own waveform and timer above the composer, so it
// is left out of the attachment strip instead of being shown twice — the same split
// the conversation composer makes between a clipped file and a voice note.
const previewFiles = computed(() =>
  attachedFiles.value.filter(file => file !== recordedFile.value)
);

function removeFile(file) {
  const index = attachedFiles.value.indexOf(file);
  if (index !== -1) attachedFiles.value.splice(index, 1);
}

// Paste and drop share the rule with the conversation composer: empty files are dropped, and
// the refusal is said out loud only when the transfer carried no text, which is what tells a
// genuine empty file apart from the invalid zero-byte attachment a rich copy brings along.
// Returns what it took, so a caller can tell "I handled this" from "there was nothing to take".
function addFiles(transfer) {
  const { files, shouldAlertEmpty } = usableFilesFromTransfer(transfer);
  if (shouldAlertEmpty) useAlert(t('CONVERSATION.FILE_IS_EMPTY'));
  if (!files.length) return false;

  attachedFiles.value = [...attachedFiles.value, ...files];
  return true;
}

// The paste is taken over only when something is actually attached. A rich copy carries its
// zero-byte artifact beside the text the person meant to paste, and cancelling the paste for
// that artifact attaches nothing in its place. The text still arrives today because the editor's
// own handler runs before this one, which is ordering rather than a decision made here.
function handlePaste(event) {
  if (!event.clipboardData?.files?.length) return;
  if (!addFiles(event.clipboardData)) return;

  event.preventDefault();
}

function hasFileDrag(event) {
  return event.dataTransfer?.types?.includes('Files');
}

function handleDragEnter(event) {
  if (!hasFileDrag(event)) return;
  event.preventDefault();
  dragCounter += 1;
  isDragging.value = true;
}

function handleDragOver(event) {
  if (!hasFileDrag(event)) return;
  event.preventDefault();
}

function handleDragLeave(event) {
  if (!hasFileDrag(event)) return;
  event.preventDefault();
  dragCounter -= 1;
  if (dragCounter <= 0) {
    dragCounter = 0;
    isDragging.value = false;
  }
}

function handleDrop(event) {
  if (!hasFileDrag(event)) return;
  event.preventDefault();
  dragCounter = 0;
  isDragging.value = false;
  addFiles(event.dataTransfer);
}

function filePreviewUrl(file) {
  return URL.createObjectURL(file);
}

function formatFileSize(file) {
  const bytes = file.size || 0;
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${Math.round(bytes / k ** i)} ${sizes[i]}`;
}

function focus() {
  focusEditor();
}

function setContent(content) {
  editorContent.value = content;
}

function getContent() {
  return editorContent.value;
}

onBeforeUnmount(() => {
  if (draftTimer) {
    clearTimeout(draftTimer);
    draftTimer = null;
    // Flush pending draft before unmounting
    emit('draftUpdate', editorContent.value);
  }
});

defineExpose({
  focus,
  setContent,
  getContent,
  resetRecorder: discardRecording,
});
</script>

<template>
  <div
    class="relative border-t border-n-slate-5 bg-n-solid-2 px-4 py-3"
    @paste="handlePaste"
    @dragenter="handleDragEnter"
    @dragover="handleDragOver"
    @dragleave="handleDragLeave"
    @drop="handleDrop"
  >
    <transition name="modal-fade">
      <div
        v-show="isDragging"
        class="pointer-events-none absolute inset-0 z-20 m-2 flex flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-n-brand bg-n-solid-2/90 text-n-brand"
      >
        <Icon icon="i-lucide-upload-cloud" class="size-6" />
        <span class="text-sm font-medium">
          {{ t('INTERNAL_CHAT.MESSAGE.DRAG_DROP') }}
        </span>
      </div>
    </transition>
    <div
      v-if="editingMessage"
      class="flex items-center justify-between border-b border-n-slate-5 px-3 py-1.5 text-xs text-n-brand"
    >
      <span class="flex items-center gap-1">
        <Icon icon="i-lucide-pencil" class="size-3" />
        {{ t('INTERNAL_CHAT.MESSAGE.EDITING') }}
      </span>
      <button class="text-n-slate-11 hover:text-n-slate-12" @click="cancelEdit">
        <Icon icon="i-lucide-x" class="size-3.5" />
      </button>
    </div>
    <label
      v-if="showAlsoSendInChannel"
      class="flex cursor-pointer items-center gap-1.5 px-1 pb-1 text-xs text-n-slate-10"
    >
      <input
        v-model="alsoSendInChannel"
        type="checkbox"
        class="rounded border-n-slate-6"
      />
      {{ t('INTERNAL_CHAT.THREAD.ALSO_SEND_IN_CHANNEL') }}
    </label>
    <!-- Audio recorder: capture, play back, discard -->
    <div
      v-if="isRecorderOpen"
      class="mb-1 flex items-center gap-2 rounded-lg border border-n-slate-6 bg-n-solid-1 px-2 py-1"
    >
      <button
        type="button"
        class="flex-shrink-0 flex items-center justify-center rounded-lg p-2 md:p-1.5 text-n-slate-11 hover:bg-n-alpha-2 hover:text-n-slate-12 transition-colors"
        :title="
          isCapturingAudio
            ? t('INTERNAL_CHAT.MESSAGE.STOP_RECORDING')
            : t('INTERNAL_CHAT.MESSAGE.PLAY_RECORDING')
        "
        @click="toggleRecorderPlayPause"
      >
        <Icon :icon="recorderPlayStopIcon" class="size-4" />
      </button>
      <span class="flex-shrink-0 text-xs tabular-nums text-n-slate-11">
        {{ recordingDuration }}
      </span>
      <AudioRecorder
        ref="audioRecorderRef"
        class="min-w-0 flex-1"
        :audio-record-format="audioRecordFormat"
        @recorder-progress-changed="onRecordProgress"
        @finish-record="onFinishRecord"
        @record-error="onRecordError"
        @play="recordingState = 'playing'"
        @pause="recordingState = 'paused'"
      />
      <button
        type="button"
        class="flex-shrink-0 flex items-center justify-center rounded-lg p-2 md:p-1.5 text-n-slate-11 hover:bg-n-alpha-2 hover:text-n-ruby-11 transition-colors"
        :title="t('INTERNAL_CHAT.MESSAGE.DISCARD_RECORDING')"
        @click="discardRecording"
      >
        <Icon icon="i-lucide-trash-2" class="size-4" />
      </button>
    </div>
    <!-- Attached files preview -->
    <div v-if="previewFiles.length" class="mb-1 flex flex-col gap-1 px-1">
      <div
        v-for="(file, index) in previewFiles"
        :key="index"
        class="flex w-full items-center gap-1.5 rounded-md bg-n-slate-3 p-1.5 sm:w-60"
      >
        <div class="flex-shrink-0">
          <img
            v-if="file.type?.startsWith('image/')"
            :src="filePreviewUrl(file)"
            class="size-8 rounded object-cover"
          />
          <span v-else class="flex size-8 items-center justify-center text-lg">
            📄
          </span>
        </div>
        <div class="min-w-0 flex-1">
          <div class="truncate text-xs font-medium text-n-slate-12">
            {{ file.name }}
          </div>
          <div class="text-[10px] text-n-slate-10">
            {{ formatFileSize(file) }}
          </div>
        </div>
        <button
          type="button"
          class="flex-shrink-0 rounded p-1 text-n-slate-10 hover:bg-n-alpha-2 hover:text-n-ruby-11"
          @click="removeFile(file)"
        >
          <Icon icon="i-lucide-x" class="size-4" />
        </button>
      </div>
    </div>
    <div
      class="flex items-end gap-2 rounded-lg border border-n-slate-6 bg-n-solid-1 px-3 py-2"
      @keydown.capture="handleKeyDown"
    >
      <div class="flex-1 min-w-0">
        <WootWriter
          ref="editorRef"
          v-model:model-value="editorContent"
          channel-type="Context::Default"
          :placeholder="placeholder || t('INTERNAL_CHAT.MESSAGE.PLACEHOLDER')"
          enable-suggestions
          enable-mention-dropdown
          enable-conversation-mention
          :enable-variables="false"
          :enable-canned-responses="false"
          :enable-captain-tools="false"
          :enable-copilot="false"
          :allow-signature="false"
          focus-on-mount
          @typing-on="handleTypingOn"
          @toggle-user-mention="handleToggleUserMention"
          @toggle-conversation-mention="handleToggleConversationMention"
        />
      </div>
      <input
        ref="fileInputRef"
        type="file"
        multiple
        class="hidden"
        @change="handleFileChange"
      />
      <button
        type="button"
        class="flex-shrink-0 flex items-center justify-center rounded-lg p-2 md:p-1.5 text-n-slate-11 hover:bg-n-alpha-2 hover:text-n-slate-12 transition-colors"
        :title="t('INTERNAL_CHAT.MESSAGE.UPLOAD_FILE')"
        @click="openFilePicker"
      >
        <Icon icon="i-lucide-paperclip" class="size-4" />
      </button>
      <button
        v-if="showRecorderButton"
        type="button"
        class="flex-shrink-0 flex items-center justify-center rounded-lg p-2 md:p-1.5 transition-colors"
        :class="
          isRecorderOpen
            ? 'text-n-ruby-11 hover:bg-n-alpha-2'
            : 'text-n-slate-11 hover:bg-n-alpha-2 hover:text-n-slate-12'
        "
        :title="
          isRecorderOpen
            ? t('INTERNAL_CHAT.MESSAGE.CANCEL_RECORDING')
            : t('INTERNAL_CHAT.MESSAGE.RECORD_AUDIO')
        "
        @click="toggleRecorder"
      >
        <Icon
          :icon="isRecorderOpen ? 'i-lucide-mic-off' : 'i-lucide-mic'"
          class="size-4"
        />
      </button>
      <!-- Mention shortcuts are hidden on the narrowest screens: they only type
      a character the on-screen keyboard already offers, and the room they take
      is worth more to the editor itself. -->
      <button
        type="button"
        class="flex-shrink-0 hidden sm:flex items-center justify-center rounded-lg p-2 md:p-1.5 text-n-slate-11 hover:bg-n-alpha-2 hover:text-n-slate-12 transition-colors"
        :title="t('INTERNAL_CHAT.MESSAGE.MENTION_USER')"
        @click="insertMentionTrigger('@')"
      >
        <Icon icon="i-lucide-at-sign" class="size-4" />
      </button>
      <button
        type="button"
        class="flex-shrink-0 hidden sm:flex items-center justify-center rounded-lg p-2 md:p-1.5 text-n-slate-11 hover:bg-n-alpha-2 hover:text-n-slate-12 transition-colors"
        :title="t('INTERNAL_CHAT.MESSAGE.MENTION_CONVERSATION')"
        @click="insertMentionTrigger('#')"
      >
        <Icon icon="i-lucide-hash" class="size-4" />
      </button>
      <button
        v-if="showPoll"
        type="button"
        class="flex-shrink-0 flex items-center justify-center rounded-lg p-2 md:p-1.5 text-n-slate-11 hover:bg-n-alpha-2 hover:text-n-slate-12 transition-colors"
        :title="t('INTERNAL_CHAT.POLL.CREATE')"
        @click="emit('createPoll')"
      >
        <Icon icon="i-lucide-bar-chart-2" class="size-4" />
      </button>
      <button
        type="button"
        class="flex-shrink-0 flex items-center justify-center rounded-lg p-2 md:p-1.5 transition-colors"
        :class="
          canSend
            ? 'bg-n-brand text-white hover:opacity-90'
            : 'text-n-slate-9 cursor-not-allowed'
        "
        :disabled="!canSend"
        :title="t('INTERNAL_CHAT.MESSAGE.SEND')"
        @click="handleSend"
      >
        <Icon icon="i-lucide-send-horizontal" class="size-4" />
      </button>
    </div>
  </div>
</template>
