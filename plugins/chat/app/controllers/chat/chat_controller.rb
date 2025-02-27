# frozen_string_literal: true

module Chat
  class ChatController < ::Chat::BaseController
    PAST_MESSAGE_LIMIT = 40
    FUTURE_MESSAGE_LIMIT = 40
    PAST = "past"
    FUTURE = "future"
    CHAT_DIRECTIONS = [PAST, FUTURE]

    # Other endpoints use set_channel_and_chatable_with_access_check, but
    # these endpoints require a standalone find because they need to be
    # able to get deleted channels and recover them.
    before_action :find_chatable, only: %i[enable_chat disable_chat]
    before_action :find_chat_message, only: %i[edit_message rebake message_link]
    before_action :set_channel_and_chatable_with_access_check,
                  except: %i[
                    respond
                    enable_chat
                    disable_chat
                    message_link
                    set_user_chat_status
                    dismiss_retention_reminder
                    flag
                  ]

    def respond
      render
    end

    def enable_chat
      chat_channel = Chat::Channel.with_deleted.find_by(chatable_id: @chatable)

      guardian.ensure_can_join_chat_channel!(chat_channel) if chat_channel

      if chat_channel && chat_channel.trashed?
        chat_channel.recover!
      elsif chat_channel
        return render_json_error I18n.t("chat.already_enabled")
      else
        chat_channel = @chatable.chat_channel
        guardian.ensure_can_join_chat_channel!(chat_channel)
      end

      success = chat_channel.save
      if success && chat_channel.chatable_has_custom_fields?
        @chatable.custom_fields[Chat::HAS_CHAT_ENABLED] = true
        @chatable.save!
      end

      if success
        membership = Chat::ChannelMembershipManager.new(channel).follow(user)
        render_serialized(chat_channel, Chat::ChannelSerializer, membership: membership)
      else
        render_json_error(chat_channel)
      end

      Chat::ChannelMembershipManager.new(channel).follow(user)
    end

    def disable_chat
      chat_channel = Chat::Channel.with_deleted.find_by(chatable_id: @chatable)
      guardian.ensure_can_join_chat_channel!(chat_channel)
      return render json: success_json if chat_channel.trashed?
      chat_channel.trash!(current_user)

      success = chat_channel.save
      if success
        if chat_channel.chatable_has_custom_fields?
          @chatable.custom_fields.delete(Chat::HAS_CHAT_ENABLED)
          @chatable.save!
        end

        render json: success_json
      else
        render_json_error(chat_channel)
      end
    end

    def create_message
      raise Discourse::InvalidAccess if current_user.silenced?

      Chat::MessageRateLimiter.run!(current_user)

      @user_chat_channel_membership =
        Chat::ChannelMembershipManager.new(@chat_channel).find_for_user(current_user)
      raise Discourse::InvalidAccess unless @user_chat_channel_membership

      reply_to_msg_id = params[:in_reply_to_id]
      if reply_to_msg_id.present?
        rm = Chat::Message.find(reply_to_msg_id)
        raise Discourse::NotFound if rm.chat_channel_id != @chat_channel.id
      end

      content = params[:message]

      chat_message_creator =
        Chat::MessageCreator.create(
          chat_channel: @chat_channel,
          user: current_user,
          in_reply_to_id: reply_to_msg_id,
          content: content,
          staged_id: params[:staged_id],
          upload_ids: params[:upload_ids],
          thread_id: params[:thread_id],
          staged_thread_id: params[:staged_thread_id],
        )

      return render_json_error(chat_message_creator.error) if chat_message_creator.failed?

      if !chat_message_creator.chat_message.thread_id.present?
        @user_chat_channel_membership.update!(
          last_read_message_id: chat_message_creator.chat_message.id,
        )
      end

      if @chat_channel.direct_message_channel?
        # If any of the channel users is ignoring, muting, or preventing DMs from
        # the current user then we should not auto-follow the channel once again or
        # publish the new channel.
        allowed_user_ids =
          UserCommScreener.new(
            acting_user: current_user,
            target_user_ids:
              @chat_channel.user_chat_channel_memberships.where(following: false).pluck(:user_id),
          ).allowing_actor_communication

        allowed_user_ids << current_user.id if !@user_chat_channel_membership.following

        if allowed_user_ids.any?
          Chat::Publisher.publish_new_channel(@chat_channel, User.where(id: allowed_user_ids))

          @chat_channel
            .user_chat_channel_memberships
            .where(user_id: allowed_user_ids)
            .update_all(following: true)
        end
      end

      message =
        (
          if chat_message_creator.chat_message.in_thread?
            Chat::Message.find(@user_chat_channel_membership.last_read_message_id)
          else
            chat_message_creator.chat_message
          end
        )

      Chat::Publisher.publish_user_tracking_state!(current_user, @chat_channel, message)
      render json: success_json.merge(message_id: message.id)
    end

    def edit_message
      chat_message_updater =
        Chat::MessageUpdater.update(
          guardian: guardian,
          chat_message: @message,
          new_content: params[:new_message],
          upload_ids: params[:upload_ids] || [],
        )

      return render_json_error(chat_message_updater.error) if chat_message_updater.failed?

      render json: success_json
    end

    def react
      params.require(%i[message_id emoji react_action])
      guardian.ensure_can_react!

      Chat::MessageReactor.new(current_user, @chat_channel).react!(
        message_id: params[:message_id],
        react_action: params[:react_action].to_sym,
        emoji: params[:emoji],
      )

      render json: success_json
    end

    def rebake
      guardian.ensure_can_rebake_chat_message!(@message)
      @message.rebake!(invalidate_oneboxes: true)
      render json: success_json
    end

    def message_link
      raise Discourse::NotFound if @message.blank? || @message.deleted_at.present?
      raise Discourse::NotFound if @message.chat_channel.blank?
      set_channel_and_chatable_with_access_check(chat_channel_id: @message.chat_channel_id)
      render json:
               success_json.merge(
                 chat_channel_id: @chat_channel.id,
                 chat_channel_title: @chat_channel.title(current_user),
               )
    end

    def set_user_chat_status
      params.require(:chat_enabled)

      current_user.user_option.update(chat_enabled: params[:chat_enabled])
      render json: { chat_enabled: current_user.user_option.chat_enabled }
    end

    def invite_users
      params.require(:user_ids)

      users =
        User
          .includes(:groups)
          .joins(:user_option)
          .where(user_options: { chat_enabled: true })
          .not_suspended
          .where(id: params[:user_ids])
      users.each do |user|
        if user.guardian.can_join_chat_channel?(@chat_channel)
          data = {
            message: "chat.invitation_notification",
            chat_channel_id: @chat_channel.id,
            chat_channel_title: @chat_channel.title(user),
            chat_channel_slug: @chat_channel.slug,
            invited_by_username: current_user.username,
          }
          data[:chat_message_id] = params[:chat_message_id] if params[:chat_message_id]
          user.notifications.create(
            notification_type: Notification.types[:chat_invitation],
            high_priority: true,
            data: data.to_json,
          )
        end
      end

      render json: success_json
    end

    def dismiss_retention_reminder
      params.require(:chatable_type)
      guardian.ensure_can_chat!
      unless Chat::Channel.chatable_types.include?(params[:chatable_type])
        raise Discourse::InvalidParameters
      end

      field =
        (
          if Chat::Channel.public_channel_chatable_types.include?(params[:chatable_type])
            :dismissed_channel_retention_reminder
          else
            :dismissed_dm_retention_reminder
          end
        )
      current_user.user_option.update(field => true)
      render json: success_json
    end

    def quote_messages
      params.require(:message_ids)

      message_ids = params[:message_ids].map(&:to_i)
      markdown =
        Chat::TranscriptService.new(
          @chat_channel,
          current_user,
          messages_or_ids: message_ids,
        ).generate_markdown
      render json: success_json.merge(markdown: markdown)
    end

    def flag
      RateLimiter.new(current_user, "flag_chat_message", 4, 1.minutes).performed!

      permitted_params =
        params.permit(
          %i[chat_message_id flag_type_id message is_warning take_action queue_for_review],
        )

      chat_message =
        Chat::Message.includes(:chat_channel, :revisions).find(permitted_params[:chat_message_id])

      flag_type_id = permitted_params[:flag_type_id].to_i

      if !ReviewableScore.types.values.include?(flag_type_id)
        raise Discourse::InvalidParameters.new(:flag_type_id)
      end

      set_channel_and_chatable_with_access_check(chat_channel_id: chat_message.chat_channel_id)

      result =
        Chat::ReviewQueue.new.flag_message(chat_message, guardian, flag_type_id, permitted_params)

      if result[:success]
        render json: success_json
      else
        render_json_error(result[:errors])
      end
    end

    def set_draft
      if params[:data].present?
        Chat::Draft.find_or_initialize_by(
          user: current_user,
          chat_channel_id: @chat_channel.id,
        ).update!(data: params[:data])
      else
        Chat::Draft.where(user: current_user, chat_channel_id: @chat_channel.id).destroy_all
      end

      render json: success_json
    end

    private

    def preloaded_chat_message_query
      query =
        Chat::Message
          .includes(in_reply_to: [:user, chat_webhook_event: [:incoming_chat_webhook]])
          .includes(:revisions)
          .includes(user: :primary_group)
          .includes(chat_webhook_event: :incoming_chat_webhook)
          .includes(reactions: :user)
          .includes(:bookmarks)
          .includes(:uploads)
          .includes(chat_channel: :chatable)
          .includes(:thread)
          .includes(:chat_mentions)

      query = query.includes(user: :user_status) if SiteSetting.enable_user_status

      query
    end

    def find_chatable
      @chatable = Category.find_by(id: params[:chatable_id])
      guardian.ensure_can_moderate_chat!(@chatable)
    end

    def find_chat_message
      @message = preloaded_chat_message_query.with_deleted
      @message = @message.where(chat_channel_id: params[:chat_channel_id]) if params[
        :chat_channel_id
      ]
      @message = @message.find_by(id: params[:message_id])
      raise Discourse::NotFound unless @message
    end
  end
end
