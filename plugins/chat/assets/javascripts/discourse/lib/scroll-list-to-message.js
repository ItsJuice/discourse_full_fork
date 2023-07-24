import { next, schedule } from "@ember/runloop";
import { stackingContextFix } from "discourse/plugins/chat/discourse/lib/chat-ios-hacks";

export default function scrollListToMessage(
  list,
  message,
  opts = { highlight: false, position: "start", autoExpand: false }
) {
  if (!message) {
    return;
  }

  if (message?.deletedAt && opts.autoExpand) {
    message.expanded = true;
  }

  next(() => {
    schedule("afterRender", () => {
      const messageEl = list.querySelector(
        `.chat-message-container[data-id='${message.id}']`
      );

      if (!messageEl) {
        return;
      }

      if (opts.highlight) {
        message.highlight();
      }

      stackingContextFix(list, () => {
        messageEl.scrollIntoView({
          behavior: opts.behavior || "auto",
          block: opts.position || "center",
        });
      });
    });
  });
}
