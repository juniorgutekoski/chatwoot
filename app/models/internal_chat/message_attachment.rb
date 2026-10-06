# == Schema Information
#
# Table name: internal_chat_message_attachments
#
#  id                       :bigint           not null, primary key
#  extension                :string
#  external_url             :string
#  file_type                :integer          default("image"), not null
#  meta                     :jsonb
#  created_at               :datetime         not null
#  updated_at               :datetime         not null
#  account_id               :bigint           not null
#  internal_chat_message_id :bigint           not null
#
# Indexes
#
#  idx_ic_msg_attachments_message                         (internal_chat_message_id)
#  index_internal_chat_message_attachments_on_account_id  (account_id)
#
# Foreign Keys
#
#  fk_rails_...  (internal_chat_message_id => internal_chat_messages.id)
#
class InternalChat::MessageAttachment < ApplicationRecord
  include Rails.application.routes.url_helpers

  self.table_name = 'internal_chat_message_attachments'

  belongs_to :account
  belongs_to :message, class_name: 'InternalChat::Message', foreign_key: :internal_chat_message_id, inverse_of: :attachments

  has_one_attached :file

  validates :file, presence: true

  enum :file_type, { image: 0, audio: 1, video: 2, file: 3 }

  # The one shape of an attachment the dashboard reads. It lives here because three places hand
  # the same hash over — the messages controller, the channel list, and the websocket payload —
  # and a field added to one of them and not the others shows up as a message that renders one
  # way live and another way after a reload.
  def push_event_data
    {
      id: id,
      file_type: file_type,
      external_url: external_url,
      extension: extension,
      file_url: file_url,
      inline_url: inline_url
    }
  end

  def file_url
    file.attached? ? url_for(file) : nil
  end

  # The pair of `Attachment#inline_storage_url`, for the same reason: `url_for(file)` carries no
  # disposition, so Active Storage serves the blob as an attachment, and Safari refuses to play
  # audio whose response says so. Only audio and video ask for inline — any other type is forced
  # back to attachment by `content_types_allowed_inline` (config/initializers/active_storage.rb).
  def inline_url
    return nil unless file.attached?
    return nil unless audio? || video?

    route_for(ActiveStorage.resolve_model_to_route, file, disposition: 'inline')
  end
end

InternalChat::MessageAttachment.prepend_mod_with('InternalChat::MessageAttachment')
