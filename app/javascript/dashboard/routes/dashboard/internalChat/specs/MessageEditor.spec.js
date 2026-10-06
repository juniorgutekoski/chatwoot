import { shallowMount } from '@vue/test-utils';
import { nextTick } from 'vue';
import MessageEditor from '../MessageEditor.vue';

const mockAlert = vi.fn();
vi.mock('dashboard/composables', async () => {
  const actual = await vi.importActual('dashboard/composables');
  return { ...actual, useAlert: (...args) => mockAlert(...args) };
});

// The composer reads the account's voice_recorder flag, which needs a store and a
// route this mount has neither of. The flag itself is varied per test below.
const mockVoiceRecorderEnabled = vi.fn(() => true);
vi.mock('dashboard/composables/useAccount', () => ({
  useAccount: () => ({
    isCloudFeatureEnabled: (...args) => mockVoiceRecorderEnabled(...args),
  }),
}));

const file = (name, type, size) =>
  new File(size ? [new Uint8Array(size)] : [], name, { type });

const mountEditor = () =>
  shallowMount(MessageEditor, {
    global: {
      mocks: { $t: key => key },
      stubs: { WootWriter: true, Icon: true },
    },
  });

// The internal chat composer answered the empty-file question three different ways at once: the
// picker attached a zero-byte file and let the send carry it (attachments here are built outside
// Messages::MessageBuilder, so nothing refuses it on the server either), while paste and drop
// dropped it without a word. None of the three said anything to the person.
describe('MessageEditor attachments', () => {
  // The paste and drop listeners sit on the composer's root element.
  const editor = wrapper => wrapper;

  // `trigger` builds its own event object, so a spy passed as an option never becomes the
  // event's `preventDefault`. Dispatching a real event is the only way to read whether the
  // handler took the paste over, which is what decides if the editor still gets the text.
  const dispatchPaste = (wrapper, clipboardData) => {
    const event = new Event('paste', { bubbles: true, cancelable: true });
    event.clipboardData = clipboardData;
    wrapper.element.dispatchEvent(event);
    return event;
  };
  const attachmentNames = wrapper =>
    wrapper.findAll('.truncate.text-xs').map(node => node.text());

  it('refuses an empty file chosen in the picker instead of attaching it', async () => {
    const wrapper = mountEditor();
    const input = wrapper.find('input[type="file"]');

    Object.defineProperty(input.element, 'files', {
      value: [file('vazio.txt', 'text/plain', 0)],
      configurable: true,
    });
    await input.trigger('change');

    expect(mockAlert).toHaveBeenCalledWith('CONVERSATION.FILE_IS_EMPTY');
    expect(attachmentNames(wrapper)).toEqual([]);
  });

  it('keeps attaching a real file chosen in the picker', async () => {
    const wrapper = mountEditor();
    const input = wrapper.find('input[type="file"]');

    Object.defineProperty(input.element, 'files', {
      value: [file('valido.txt', 'text/plain', 4)],
      configurable: true,
    });
    await input.trigger('change');

    expect(mockAlert).not.toHaveBeenCalled();
    expect(attachmentNames(wrapper)).toEqual(['valido.txt']);
  });

  it('says the pasted file was empty, since a paste of Files alone carries no text', async () => {
    const wrapper = mountEditor();

    await editor(wrapper).trigger('paste', {
      clipboardData: {
        types: ['Files'],
        files: [file('vazio.txt', 'text/plain', 0)],
      },
    });

    expect(mockAlert).toHaveBeenCalledWith('CONVERSATION.FILE_IS_EMPTY');
  });

  // Internal chat has no macOS Numbers argument of its own, but it shares the composer's rule so
  // the two do not drift: a rich copy brings an invalid zero-byte attachment beside its text.
  it('stays quiet for a rich paste that carries text beside its empty attachment', async () => {
    const wrapper = mountEditor();

    await editor(wrapper).trigger('paste', {
      clipboardData: {
        types: ['text/plain', 'text/html', 'text/rtf', 'Files'],
        files: [file('image.png', 'image/png', 0)],
      },
    });

    expect(mockAlert).not.toHaveBeenCalled();
  });

  it('still attaches a real pasted file', async () => {
    const wrapper = mountEditor();

    await editor(wrapper).trigger('paste', {
      clipboardData: {
        types: ['Files'],
        files: [file('valido.txt', 'text/plain', 4)],
      },
    });

    expect(mockAlert).not.toHaveBeenCalled();
    expect(attachmentNames(wrapper)).toEqual(['valido.txt']);
  });

  // A rich copy brings its zero-byte artifact along with the text the person actually copied, and
  // the paste handler used to call preventDefault() the moment it saw any file, cancelling a
  // paste that then attached nothing. Measured in a browser, the text still lands, because the
  // editor's own paste handler runs first and inserts it. Nothing is lost today, and that is the
  // point: the text survives by listener ordering rather than by anything this code decided.
  it('lets the text of a rich paste through instead of eating it for an empty artifact', async () => {
    const wrapper = mountEditor();

    const event = dispatchPaste(wrapper, {
      types: ['text/plain', 'text/html', 'text/rtf', 'Files'],
      files: [file('image.png', 'image/png', 0)],
    });
    await nextTick();

    expect(event.defaultPrevented).toBe(false);
    expect(mockAlert).not.toHaveBeenCalled();
    expect(attachmentNames(wrapper)).toEqual([]);
  });

  it('still takes over the paste when there is a real file to attach', async () => {
    const wrapper = mountEditor();

    const event = dispatchPaste(wrapper, {
      types: ['Files'],
      files: [file('valido.txt', 'text/plain', 4)],
    });
    await nextTick();

    expect(event.defaultPrevented).toBe(true);
    expect(attachmentNames(wrapper)).toEqual(['valido.txt']);
  });

  it('applies the same rule to a drop', async () => {
    const wrapper = mountEditor();

    await editor(wrapper).trigger('drop', {
      dataTransfer: {
        types: ['Files'],
        files: [file('vazio.txt', 'text/plain', 0)],
      },
    });

    expect(mockAlert).toHaveBeenCalledWith('CONVERSATION.FILE_IS_EMPTY');
  });
});

// A voice note is recorded in the browser and uploaded as an ordinary attachment — the server
// already files an audio/* upload under the audio type. So everything here is about the composer
// not losing the capture, and not keeping one the person threw away.
describe('MessageEditor voice notes', () => {
  const recordedNote = () => file('nota.mp3', 'audio/mp3', 64);

  // Whether the microphone actually started. A refused permission leaves the panel open over a
  // capture that never began, which is the state the composer has to survive.
  let isMicrophoneArmed = true;
  const stopRecording = vi.fn();
  // An auto-stub answers no method call and carries no exposed state, and the composer asks the
  // recorder for both: stopRecording(), and the record plugin it exposes.
  const audioRecorderStub = {
    name: 'AudioRecorder',
    template: '<div />',
    data: () => ({ record: { isRecording: () => isMicrophoneArmed } }),
    methods: {
      stopRecording: (...args) => stopRecording(...args),
      playPause: () => {},
    },
  };
  const mountWithRecorder = () =>
    shallowMount(MessageEditor, {
      global: {
        mocks: { $t: key => key },
        stubs: {
          WootWriter: true,
          Icon: true,
          AudioRecorder: audioRecorderStub,
        },
      },
    });
  const recorder = wrapper => wrapper.findComponent(audioRecorderStub);
  const button = (wrapper, key) =>
    wrapper.find(`[title="INTERNAL_CHAT.MESSAGE.${key}"]`);
  const attachedNames = wrapper =>
    wrapper.findAll('.truncate.text-xs').map(node => node.text());
  const finishRecording = async (
    wrapper,
    payload = { file: recordedNote() }
  ) => {
    recorder(wrapper).vm.$emit('finishRecord', payload);
    await nextTick();
  };

  // jsdom has neither MediaRecorder nor a microphone — which is also what the composer sees on
  // an insecure origin, where getUserMedia is not handed out at all.
  const grantMediaRecorder = () => {
    window.MediaRecorder = class {};
  };
  const grantMicrophone = () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: () => Promise.resolve({}) },
      configurable: true,
    });
  };
  const allowRecording = () => {
    grantMediaRecorder();
    grantMicrophone();
  };

  beforeEach(() => {
    mockVoiceRecorderEnabled.mockReturnValue(true);
    isMicrophoneArmed = true;
  });

  afterEach(() => {
    delete window.MediaRecorder;
    Object.defineProperty(navigator, 'mediaDevices', {
      value: undefined,
      configurable: true,
    });
  });

  it('offers the microphone when the browser can record', () => {
    allowRecording();
    expect(button(mountWithRecorder(), 'RECORD_AUDIO').exists()).toBe(true);
  });

  it('hides the microphone when the browser has no MediaRecorder', () => {
    grantMicrophone();
    expect(button(mountWithRecorder(), 'RECORD_AUDIO').exists()).toBe(false);
  });

  it('hides the microphone when there is no microphone to open', () => {
    grantMediaRecorder();
    expect(button(mountWithRecorder(), 'RECORD_AUDIO').exists()).toBe(false);
  });

  it('hides the microphone when the account has the voice recorder turned off', () => {
    allowRecording();
    mockVoiceRecorderEnabled.mockReturnValue(false);

    expect(button(mountWithRecorder(), 'RECORD_AUDIO').exists()).toBe(false);
  });

  // The recorder shows the capture with its own waveform and timer, so listing the file again in
  // the attachment strip would show one recording twice.
  it('keeps the recording out of the attachment strip and still sends it', async () => {
    allowRecording();
    const wrapper = mountWithRecorder();

    await button(wrapper, 'RECORD_AUDIO').trigger('click');
    await finishRecording(wrapper);

    expect(attachedNames(wrapper)).toEqual([]);
    await button(wrapper, 'SEND').trigger('click');
    expect(wrapper.emitted('send')[0][1].files.map(f => f.name)).toEqual([
      'nota.mp3',
    ]);
  });

  // Pressing send while the microphone is still capturing would otherwise be a dead click: the
  // blob only exists once the recorder stops, so the send waits for it instead of dropping what
  // was just said.
  it('sends the note recorded up to the moment send was pressed', async () => {
    allowRecording();
    const wrapper = mountWithRecorder();

    await button(wrapper, 'RECORD_AUDIO').trigger('click');
    await button(wrapper, 'SEND').trigger('click');
    expect(stopRecording).toHaveBeenCalled();
    expect(wrapper.emitted('send')).toBeUndefined();

    await finishRecording(wrapper);

    expect(wrapper.emitted('send')[0][1].files.map(f => f.name)).toEqual([
      'nota.mp3',
    ]);
  });

  it('closes the recorder once the note is sent, instead of recording on', async () => {
    allowRecording();
    const wrapper = mountWithRecorder();

    await button(wrapper, 'RECORD_AUDIO').trigger('click');
    await finishRecording(wrapper);
    await button(wrapper, 'SEND').trigger('click');

    expect(recorder(wrapper).exists()).toBe(false);
  });

  it('discards the recording instead of carrying it into the next message', async () => {
    allowRecording();
    const wrapper = mountWithRecorder();

    await button(wrapper, 'RECORD_AUDIO').trigger('click');
    await finishRecording(wrapper);
    await button(wrapper, 'DISCARD_RECORDING').trigger('click');

    expect(recorder(wrapper).exists()).toBe(false);
    expect(button(wrapper, 'SEND').attributes('disabled')).toBeDefined();
  });

  // Encoding a long note takes seconds, so the capture can arrive after the person already threw
  // it away. Attached then, it would be invisible — the recorder is closed and the strip filters
  // the recording out — and would ride along with whatever they send next.
  it('ignores a capture that lands after the recording was discarded', async () => {
    allowRecording();
    const wrapper = mountWithRecorder();

    await button(wrapper, 'RECORD_AUDIO').trigger('click');
    // Held before the cancel, and the cancel is deliberately not awaited: Vue's emit drops
    // events from an unmounted instance, so awaiting here would flush the unmount and the
    // guard under test would never be reached — a test that passes with the guard deleted.
    const encoding = recorder(wrapper);
    button(wrapper, 'CANCEL_RECORDING').trigger('click');
    encoding.vm.$emit('finishRecord', { file: recordedNote() });
    await nextTick();

    wrapper.vm.setContent('segue o texto');
    await nextTick();
    await button(wrapper, 'SEND').trigger('click');

    expect(wrapper.emitted('send')[0][1].files).toEqual([]);
  });

  // Speak, press stop, press send — the most ordinary gesture there is. Between the stop and the
  // encoded file the microphone already reads as idle, so a send that asked only "is the mic on?"
  // would leave without the note, and the note would then be dropped for arriving late.
  it('waits for the note that is still being encoded when send is pressed after stop', async () => {
    allowRecording();
    const wrapper = mountWithRecorder();

    await button(wrapper, 'RECORD_AUDIO').trigger('click');
    recorder(wrapper).vm.$emit('recorderProgressChanged', '00:03');
    await nextTick();

    // The stop: the plugin is idle from here on, and the encoder has not answered yet.
    isMicrophoneArmed = false;
    await button(wrapper, 'STOP_RECORDING').trigger('click');
    await button(wrapper, 'SEND').trigger('click');
    expect(wrapper.emitted('send')).toBeUndefined();

    await finishRecording(wrapper);

    expect(wrapper.emitted('send')[0][1].files.map(f => f.name)).toEqual([
      'nota.mp3',
    ]);
  });

  // A refused permission never reaches record-end, so a send that waits for the blob would wait
  // forever: the agent presses send on a typed message and nothing happens, with nothing said.
  it('still sends the typed message when the microphone never started', async () => {
    allowRecording();
    isMicrophoneArmed = false;
    const wrapper = mountWithRecorder();

    await button(wrapper, 'RECORD_AUDIO').trigger('click');
    wrapper.vm.setContent('o microfone foi negado');
    await nextTick();
    await button(wrapper, 'SEND').trigger('click');

    const [content, options] = wrapper.emitted('send')[0];
    expect(content).toBe('o microfone foi negado');
    expect(options.files).toEqual([]);
  });

  // Two different accidents, and only one of them is about a permission: telling someone to
  // check the microphone when the encoder choked sends them to the wrong place.
  it('says the microphone could not be opened when that is what happened', async () => {
    allowRecording();
    const wrapper = mountWithRecorder();

    await button(wrapper, 'RECORD_AUDIO').trigger('click');
    recorder(wrapper).vm.$emit('recordError', {
      error: new Error('denied'),
      stage: 'start',
    });
    await nextTick();

    expect(mockAlert).toHaveBeenCalledWith(
      'INTERNAL_CHAT.MESSAGE.MICROPHONE_UNAVAILABLE'
    );
    expect(recorder(wrapper).exists()).toBe(false);
  });

  it('says the recording could not be prepared when the encoder failed', async () => {
    allowRecording();
    const wrapper = mountWithRecorder();

    await button(wrapper, 'RECORD_AUDIO').trigger('click');
    recorder(wrapper).vm.$emit('recordError', {
      error: new Error('lamejs'),
      stage: 'conversion',
    });
    await nextTick();

    expect(mockAlert).toHaveBeenCalledWith(
      'INTERNAL_CHAT.MESSAGE.AUDIO_CONVERSION_FAILED'
    );
    expect(recorder(wrapper).exists()).toBe(false);
  });
});
