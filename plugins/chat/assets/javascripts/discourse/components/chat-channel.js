import ChatMessage from "discourse/plugins/chat/discourse/models/chat-message";
import Component from "@glimmer/component";
import { bind } from "discourse-common/utils/decorators";
import { action } from "@ember/object";
// TODO (martin) Remove this when the handleSentMessage logic inside chatChannelPaneSubscriptionsManager
// is moved over from this file completely.
import { handleStagedMessage } from "discourse/plugins/chat/discourse/services/chat-pane-base-subscriptions-manager";
import { popupAjaxError } from "discourse/lib/ajax-error";
import { cancel, next, schedule } from "@ember/runloop";
import { inject as service } from "@ember/service";
import { resetIdle } from "discourse/lib/desktop-notifications";
import {
  onPresenceChange,
  removeOnPresenceChange,
} from "discourse/lib/user-presence";
import {
  bodyScrollFix,
  stackingContextFix,
} from "discourse/plugins/chat/discourse/lib/chat-ios-hacks";
import scrollListToMessage from "discourse/plugins/chat/discourse/lib/scroll-list-to-message";
import {
  checkMessageBottomVisibility,
  checkMessageTopVisibility,
} from "discourse/plugins/chat/discourse/lib/check-message-visibility";
import ChatMessagesLoader from "discourse/plugins/chat/discourse/lib/chat-messages-loader";
import { cached, tracked } from "@glimmer/tracking";
import discourseDebounce from "discourse-common/lib/debounce";
import DiscourseURL from "discourse/lib/url";
import { getOwner } from "discourse-common/lib/get-owner";
import {
  FUTURE,
  PAST,
  READ_INTERVAL_MS,
} from "discourse/plugins/chat/discourse/lib/chat-constants";

export default class ChatChannel extends Component {
  @service appEvents;
  @service capabilities;
  @service chat;
  @service chatApi;
  @service chatChannelsManager;
  @service chatChannelPaneSubscriptionsManager;
  @service chatComposerPresenceManager;
  @service chatDraftsManager;
  @service chatEmojiPickerManager;
  @service chatStateManager;
  @service("chat-channel-composer") composer;
  @service("chat-channel-pane") pane;
  @service currentUser;
  @service messageBus;
  @service router;
  @service site;

  @tracked sending = false;
  @tracked showChatQuoteSuccess = false;
  @tracked includeHeader = true;
  @tracked needsArrow = false;
  @tracked atBottom = false;
  @tracked uploadDropZone;
  @tracked isScrolling = false;

  scrollable = null;
  _loadedChannelId = null;
  _mentionWarningsSeen = {};
  _unreachableGroupMentions = [];
  _overMembersLimitGroupMentions = [];

  @cached
  get messagesLoader() {
    return new ChatMessagesLoader(getOwner(this), this.args.channel);
  }

  get messagesManager() {
    return this.args.channel.messagesManager;
  }

  get currentUserMembership() {
    return this.args.channel.currentUserMembership;
  }

  @action
  setUploadDropZone(element) {
    this.uploadDropZone = element;
  }

  @action
  setScrollable(element) {
    this.scrollable = element;
  }

  @action
  setupListeners() {
    onPresenceChange({ callback: this.onPresenceChangeCallback });
  }

  @action
  teardownListeners() {
    this.#cancelHandlers();
    removeOnPresenceChange(this.onPresenceChangeCallback);
    this.unsubscribeToUpdates(this._loadedChannelId);
  }

  @action
  didResizePane() {
    this._recentlyResized = true;
    this.debounceFillPaneAttempt();
    this.computeDatesSeparators();
  }

  @action
  resetIdle() {
    resetIdle();
  }

  @action
  didUpdateChannel() {
    this.#cancelHandlers();

    if (!this.args.channel) {
      return;
    }

    this.messagesManager.clear();

    if (
      this.args.channel.isDirectMessageChannel &&
      !this.args.channel.isFollowing
    ) {
      this.chatChannelsManager.follow(this.args.channel);
    }

    if (this._loadedChannelId !== this.args.channel.id) {
      this.unsubscribeToUpdates(this._loadedChannelId);
      this.pane.selectingMessages = false;
      this._loadedChannelId = this.args.channel.id;
    }

    const existingDraft = this.chatDraftsManager.get({
      channelId: this.args.channel.id,
    });
    if (existingDraft) {
      this.composer.message = existingDraft;
    } else {
      this.resetComposerMessage();
    }

    this.composer.focus();
    this.scrollToBottom();
    this.loadMessages();

    // We update this value server-side when we load the Channel
    // here, so this reflects reality for sidebar unread logic.
    this.args.channel.updateLastViewedAt();
  }

  @action
  loadMessages() {
    if (!this.args.channel?.id) {
      return;
    }

    this.subscribeToUpdates(this.args.channel);

    if (this.args.targetMessageId) {
      this.debounceHighlightOrFetchMessage(this.args.targetMessageId);
    } else {
      this.debounceFetchMessages({ fetch_from_last_read: true });
    }
  }

  @bind
  onPresenceChangeCallback(present) {
    if (present) {
      this.debouncedUpdateLastReadMessage();
    }
  }

  debounceFetchMessages(options) {
    this._debounceFetchMessagesHandler = discourseDebounce(
      this,
      this.fetchMessages,
      options,
      100
    );
  }

  async fetchMessages(findArgs = {}) {
    if (this.messagesLoader.loading) {
      return;
    }

    this.messagesManager.clear();

    const result = await this.messagesLoader.load(findArgs);
    this.messagesManager.messages = this.processMessages(
      this.args.channel,
      result
    );

    if (findArgs.target_message_id) {
      this.scrollToMessageId(findArgs.target_message_id, { highlight: true });
    } else if (findArgs.fetch_from_last_read) {
      const lastReadMessageId = this.currentUserMembership?.lastReadMessageId;
      this.scrollToMessageId(lastReadMessageId);
    } else if (findArgs.target_date) {
      this.scrollToMessageId(result.meta.target_message_id, {
        highlight: true,
        position: "center",
      });
    } else {
      this.scrollToBottom();
    }

    this.debounceFillPaneAttempt();
    this.debouncedUpdateLastReadMessage();
  }

  async fetchMoreMessages({ direction }, opts = {}) {
    if (this.messagesLoader.loading) {
      return;
    }

    const result = await this.messagesLoader.loadMore({ direction });
    if (!result) {
      return;
    }

    const messages = this.processMessages(this.args.channel, result);
    if (!messages.length) {
      return;
    }

    const targetMessageId = this.messagesManager.messages.lastObject.id;
    this.messagesManager.addMessages(messages);
    if (direction === FUTURE && !opts.noScroll) {
      this.scrollToMessageId(targetMessageId, {
        position: "end",
        forceAuto: true,
      });
    }

    this.debounceFillPaneAttempt();
  }

  scrollToMessageId(messageId, options = {}) {
    const message = this.messagesManager.findMessage(messageId);
    scrollListToMessage(this.scrollable, message, options);
  }

  debounceFillPaneAttempt() {
    if (!this.messagesLoader.fetchedOnce) {
      return;
    }

    this._debouncedFillPaneAttemptHandler = discourseDebounce(
      this,
      this.fillPaneAttempt,
      500
    );
  }

  @bind
  fetchMessagesByDate(date) {
    const message = this.messagesManager.findFirstMessageOfDay(new Date(date));
    if (message.firstOfResults && this.messagesLoader.canLoadMorePast) {
      this.fetchMessages({ target_date: date, direction: FUTURE });
    } else {
      this.highlightOrFetchMessage(message.id, { position: "center" });
    }
  }

  async fillPaneAttempt() {
    // safeguard
    if (this.messagesManager.messages.length > 200) {
      return;
    }

    if (!this.messagesLoader.canLoadMorePast) {
      return;
    }

    schedule("afterRender", () => {
      const firstMessageId = this.messagesManager.messages.firstObject?.id;
      const messageContainer = this.scrollable.querySelector(
        `.chat-message-container[data-id="${firstMessageId}"]`
      );
      if (
        messageContainer &&
        checkMessageTopVisibility(this.scrollable, messageContainer)
      ) {
        this.fetchMoreMessages({ direction: PAST }, { noScroll: true });
      }
    });
  }

  @bind
  processMessages(channel, result) {
    const messages = [];
    let foundFirstNew = false;
    const hasNewest = this.messagesManager.messages.some((m) => m.newest);

    result.messages.forEach((messageData, index) => {
      messageData.firstOfResults = index === 0;

      if (this.currentUser.ignored_users) {
        // If a message has been hidden it is because the current user is ignoring
        // the user who sent it, so we want to unconditionally hide it, even if
        // we are going directly to the target
        messageData.hidden = this.currentUser.ignored_users.includes(
          messageData.user.username
        );
      }

      if (this.requestedTargetMessageId === messageData.id) {
        messageData.expanded = !messageData.hidden;
      } else {
        messageData.expanded = !(messageData.hidden || messageData.deleted_at);
      }

      // newest has to be in after fetch callback as we don't want to make it
      // dynamic or it will make the pane jump around, it will disappear on reload
      if (
        !hasNewest &&
        !foundFirstNew &&
        messageData.id > this.currentUserMembership?.lastReadMessageId
      ) {
        foundFirstNew = true;
        messageData.newest = true;
      }

      const message = ChatMessage.create(channel, messageData);
      message.manager = channel.messagesManager;

      if (message.thread) {
        this.#preloadThreadTrackingState(
          message.thread,
          result.tracking.thread_tracking
        );
      }

      messages.push(message);
    });

    return messages;
  }

  debounceHighlightOrFetchMessage(messageId, options = {}) {
    this._debouncedHighlightOrFetchMessageHandler = discourseDebounce(
      this,
      this.highlightOrFetchMessage,
      messageId,
      options,
      100
    );
  }

  highlightOrFetchMessage(messageId, options = {}) {
    const message = this.messagesManager.findMessage(messageId);
    if (message) {
      this.scrollToMessageId(
        message.id,
        Object.assign(
          {
            highlight: true,
            position: "start",
            autoExpand: true,
            behavior: this.capabilities.isIOS ? "smooth" : null,
          },
          options
        )
      );
    } else {
      this.debounceFetchMessages({ target_message_id: messageId });
    }
  }

  debouncedUpdateLastReadMessage() {
    this._debouncedUpdateLastReadMessageHandler = discourseDebounce(
      this,
      this.updateLastReadMessage,
      READ_INTERVAL_MS
    );
  }

  updateLastReadMessage() {
    if (!this.args.channel.isFollowing) {
      return;
    }

    schedule("afterRender", () => {
      let lastFullyVisibleMessageNode = null;

      this.scrollable
        .querySelectorAll(".chat-message-container")
        .forEach((item) => {
          if (checkMessageBottomVisibility(this.scrollable, item)) {
            lastFullyVisibleMessageNode = item;
          }
        });

      if (!lastFullyVisibleMessageNode) {
        return;
      }

      let lastUnreadVisibleMessage = this.messagesManager.findMessage(
        lastFullyVisibleMessageNode.dataset.id
      );

      if (!lastUnreadVisibleMessage) {
        return;
      }

      const lastReadId =
        this.args.channel.currentUserMembership?.lastReadMessageId;
      if (lastReadId >= lastUnreadVisibleMessage.id) {
        return;
      }

      return this.chatApi.markChannelAsRead(
        this.args.channel.id,
        lastUnreadVisibleMessage.id
      );
    });
  }

  @action
  scrollToLatestMessage() {
    if (this.messagesLoader.canLoadMoreFuture) {
      this.debounceFetchMessages({ fetch_from_last_read: true });
    } else if (this.messagesManager.messages.length > 0) {
      this.scrollToBottom({
        behavior: this.capabilities.isIOS ? "smooth" : null,
      });
    }
  }

  @action
  onScroll(state) {
    bodyScrollFix();

    next(() => {
      if (this.#flushRecentResized()) {
        return;
      }

      this.needsArrow =
        (this.messagesLoader.fetchedOnce &&
          this.messagesLoader.canLoadMoreFuture) ||
        (state.distanceToBottom.pixels > 250 && !state.atBottom);
      this.isScrolling = true;
      this.debouncedUpdateLastReadMessage();

      if (
        state.atTop ||
        (!this.capabilities.isIOS &&
          state.up &&
          state.distanceToTop.percentage < 40)
      ) {
        this.fetchMoreMessages({ direction: PAST });
      } else if (state.atBottom) {
        this.fetchMoreMessages({ direction: FUTURE });
      }
    });
  }

  @action
  onScrollEnd(state) {
    this.needsArrow =
      (this.messagesLoader.fetchedOnce &&
        this.messagesLoader.canLoadMoreFuture) ||
      (state.distanceToBottom.pixels > 250 && !state.atBottom);
    this.isScrolling = false;
    this.resetIdle();
    this.atBottom = state.atBottom;

    if (state.atBottom) {
      this.fetchMoreMessages({ direction: FUTURE });
    }

    stackingContextFix(this.scrollable);
  }

  @bind
  onMessage(data) {
    switch (data.type) {
      case "sent":
        this.handleSentMessage(data);
        break;
    }
  }

  handleSentMessage(data) {
    if (data.chat_message.user.id === this.currentUser.id && data.staged_id) {
      const stagedMessage = handleStagedMessage(
        this.args.channel,
        this.messagesManager,
        data
      );
      if (stagedMessage) {
        return;
      }
    }

    const message = ChatMessage.create(this.args.channel, data.chat_message);
    message.manager = this.args.channel.messagesManager;
    this.messagesManager.addMessages([message]);
    this.args.channel.lastMessage = message;

    if (this.atBottom) {
      this.debouncedUpdateLastReadMessage();
    }

    stackingContextFix(this.scrollable);
  }

  @action
  async onSendMessage(message) {
    await message.cook();
    if (message.editing) {
      await this.#sendEditMessage(message);
    } else {
      await this.#sendNewMessage(message);
    }
  }

  @action
  resetComposerMessage() {
    this.composer.reset(this.args.channel);
  }

  async #sendEditMessage(message) {
    this.pane.sending = true;

    const data = {
      new_message: message.message,
      upload_ids: message.uploads.map((upload) => upload.id),
    };

    this.resetComposerMessage();

    try {
      return await this.chatApi.editMessage(
        this.args.channel.id,
        message.id,
        data
      );
    } catch (e) {
      popupAjaxError(e);
    } finally {
      this.chatDraftsManager.remove({ channelId: this.args.channel.id });
      this.pane.sending = false;
    }
  }

  async #sendNewMessage(message) {
    this.pane.sending = true;

    resetIdle();

    await this.args.channel.stageMessage(message);
    message.manager = this.args.channel.messagesManager;
    this.resetComposerMessage();

    stackingContextFix(this.scrollable);

    if (!this.atBottom && !this.messagesLoader.canLoadMoreFuture) {
      this.scrollToLatestMessage();
    }

    try {
      await this.chatApi.sendMessage(this.args.channel.id, {
        message: message.message,
        in_reply_to_id: message.inReplyTo?.id,
        staged_id: message.id,
        upload_ids: message.uploads.map((upload) => upload.id),
      });
    } catch (error) {
      this._onSendError(message.id, error);
    } finally {
      this.chatDraftsManager.remove({ channelId: this.args.channel.id });
      this.pane.sending = false;
    }
  }

  _onSendError(id, error) {
    const stagedMessage =
      this.args.channel.messagesManager.findStagedMessage(id);
    if (stagedMessage) {
      if (error.jqXHR?.responseJSON?.errors?.length) {
        // only network errors are retryable
        stagedMessage.message = "";
        stagedMessage.cooked = "";
        stagedMessage.error = error.jqXHR.responseJSON.errors[0];
      } else {
        this.chat.markNetworkAsUnreliable();
        stagedMessage.error = "network_error";
      }
    }

    this.resetComposerMessage();
  }

  @action
  resendStagedMessage(stagedMessage) {
    this.pane.sending = true;

    stagedMessage.error = null;

    const data = {
      cooked: stagedMessage.cooked,
      message: stagedMessage.message,
      upload_ids: stagedMessage.uploads.map((upload) => upload.id),
      staged_id: stagedMessage.id,
    };

    this.chatApi
      .sendMessage(this.args.channel.id, data)
      .catch((error) => {
        this._onSendError(data.staged_id, error);
      })
      .then(() => {
        this.chat.markNetworkAsReliable();
      })
      .finally(() => {
        this.pane.sending = false;
      });
  }

  @action
  onCloseFullScreen() {
    this.chatStateManager.prefersDrawer();

    DiscourseURL.routeTo(this.chatStateManager.lastKnownAppURL).then(() => {
      DiscourseURL.routeTo(this.chatStateManager.lastKnownChatURL);
    });
  }

  unsubscribeToUpdates(channelId) {
    if (!channelId) {
      return;
    }

    this.chatChannelPaneSubscriptionsManager.unsubscribe();
    this.messageBus.unsubscribe(`/chat/${channelId}`, this.onMessage);
  }

  subscribeToUpdates(channel) {
    if (!channel) {
      return;
    }

    this.unsubscribeToUpdates(channel.id);
    this.messageBus.subscribe(
      `/chat/${channel.id}`,
      this.onMessage,
      channel.channelMessageBusLastId
    );
    this.chatChannelPaneSubscriptionsManager.subscribe(channel);
  }

  @action
  addAutoFocusEventListener() {
    document.addEventListener("keydown", this._autoFocus);
  }

  @action
  removeAutoFocusEventListener() {
    document.removeEventListener("keydown", this._autoFocus);
  }

  @bind
  _autoFocus(event) {
    if (this.chatStateManager.isDrawerActive) {
      return;
    }

    const { key, metaKey, ctrlKey, code, target } = event;

    if (
      !key ||
      // Handles things like Enter, Tab, Shift
      key.length > 1 ||
      // Don't need to focus if the user is beginning a shortcut.
      metaKey ||
      ctrlKey ||
      // Space's key comes through as ' ' so it's not covered by key
      code === "Space" ||
      // ? is used for the keyboard shortcut modal
      key === "?"
    ) {
      return;
    }

    if (!target || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) {
      return;
    }

    event.preventDefault();
    this.composer.focus({ addText: event.key });
    return;
  }

  @action
  scrollToBottom(opts = {}) {
    const message = this.messagesManager.messages.lastObject;
    if (!message) {
      return;
    }

    scrollListToMessage(this.scrollable, message, opts);
  }

  @bind
  computeDatesSeparators() {
    schedule("afterRender", () => {
      if (!this.scrollable) {
        return;
      }

      const dates = [
        ...this.scrollable.querySelectorAll(".chat-message-separator-date"),
      ].reverse();
      const height = this.scrollable.querySelector(
        ".chat-messages-container"
      ).clientHeight;

      dates
        .map((date, index) => {
          const item = { bottom: 0, date };
          const line = date.nextElementSibling;

          if (index > 0) {
            const prevDate = dates[index - 1];
            const prevLine = prevDate.nextElementSibling;
            item.bottom = height - prevLine.offsetTop;
          }

          if (dates.length === 1) {
            item.height = height;
          } else {
            if (index === 0) {
              item.height = height - line.offsetTop;
            } else {
              const prevDate = dates[index - 1];
              const prevLine = prevDate.nextElementSibling;
              item.height =
                height - line.offsetTop - (height - prevLine.offsetTop);
            }
          }

          return item;
        })
        // group all writes at the end
        .forEach((item) => {
          item.date.style.bottom = item.bottom + "px";
          item.date.style.height = item.height + "px";
        });
    });
  }

  #isBottomOfMessageVisible(element, container) {
    const rect = element.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    // - 5.0 to account for rounding errors, especially on firefox
    return rect.bottom - 5.0 <= containerRect.bottom;
  }

  #cancelHandlers() {
    cancel(this._debouncedHighlightOrFetchMessageHandler);
    cancel(this._debouncedUpdateLastReadMessageHandler);
    cancel(this._debouncedFillPaneAttemptHandler);
    cancel(this._debounceFetchMessagesHandler);
  }

  #preloadThreadTrackingState(thread, threadTracking) {
    if (!threadTracking[thread.id]) {
      return;
    }

    thread.tracking.unreadCount = threadTracking[thread.id].unread_count;
    thread.tracking.mentionCount = threadTracking[thread.id].mention_count;
  }

  #flushRecentResized() {
    const prev = this._recentlyResized;
    this._recentlyResized = false;
    return prev;
  }
}
