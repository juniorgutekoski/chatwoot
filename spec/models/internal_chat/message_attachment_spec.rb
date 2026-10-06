# frozen_string_literal: true

require 'rails_helper'

RSpec.describe InternalChat::MessageAttachment do
  describe 'associations' do
    it { is_expected.to belong_to(:account) }
    it { is_expected.to belong_to(:message).class_name('InternalChat::Message') }
  end

  describe 'enums' do
    it { is_expected.to define_enum_for(:file_type).with_values(image: 0, audio: 1, video: 2, file: 3) }
  end

  describe 'ActiveStorage attachment' do
    it 'has one attached file' do
      expect(described_class.new.file).to be_an_instance_of(ActiveStorage::Attached::One)
    end
  end

  # The player cannot use a URL that is served as an attachment: Safari refuses to play audio
  # whose response says so. `inline_url` is the half that asks, and `content_types_allowed_inline`
  # (config/initializers/active_storage.rb) is the half that grants — asking alone is not enough,
  # because `Blob#url` applies `forced_disposition_for_serving` over whatever the caller asked.
  describe '#inline_url' do
    let(:message) { create(:internal_chat_message) }

    def attach(filename, content_type, file_type)
      attachment = message.attachments.new(account: message.account, file_type: file_type)
      attachment.file.attach(io: Rails.root.join("spec/assets/#{filename}").open, filename: filename,
                             content_type: content_type)
      attachment.save!
      attachment
    end

    it 'asks for an inline disposition for audio' do
      expect(attach('sample.mp3', 'audio/mpeg', :audio).inline_url).to match(/disposition=inline/)
    end

    it 'asks for an inline disposition for video' do
      expect(attach('sample.mp4', 'video/mp4', :video).inline_url).to match(/disposition=inline/)
    end

    # Anything else is forced back to attachment anyway, so an inline URL would only promise
    # what the blob will not deliver.
    it 'has nothing to offer for other types' do
      expect(attach('avatar.png', 'image/png', :image).inline_url).to be_nil
    end

    it 'is empty while no file is attached' do
      expect(described_class.new(file_type: :audio).inline_url).to be_nil
    end

    # What the browser sends for a note recorded in the dashboard: lamejs labels the blob
    # `audio/mp3`, which is not the registered name and is not in the allowlist. It plays today
    # because Active Storage identifies the bytes and stores `audio/mpeg` — if that ever stops
    # being true, every recorded note is served as a download instead.
    it 'is not forced back to attachment for a note the recorder labelled audio/mp3' do
      recorded = attach('sample.mp3', 'audio/mp3', :audio)

      expect(recorded.file.blob.content_type).to eq('audio/mpeg')
      expect(recorded.file.blob.send(:forced_disposition_for_serving)).to be_nil
    end
  end

  describe 'factory' do
    it 'creates a valid attachment' do
      attachment = create(:internal_chat_message_attachment)
      expect(attachment).to be_valid
      expect(attachment).to be_persisted
    end

    it 'supports different file types' do
      image_attachment = build(:internal_chat_message_attachment, file_type: :image)
      expect(image_attachment).to be_image

      audio_attachment = build(:internal_chat_message_attachment, file_type: :audio)
      expect(audio_attachment).to be_audio

      video_attachment = build(:internal_chat_message_attachment, file_type: :video)
      expect(video_attachment).to be_video

      file_attachment = build(:internal_chat_message_attachment, file_type: :file)
      expect(file_attachment).to be_file
    end
  end
end
