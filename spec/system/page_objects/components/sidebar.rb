# frozen_string_literal: true

module PageObjects
  module Components
    class Sidebar < PageObjects::Components::Base
      def visible?
        page.has_css?("#d-sidebar")
      end

      def not_visible?
        page.has_no_css?("#d-sidebar")
      end

      def has_category_section_link?(category)
        page.has_link?(category.name, class: "sidebar-section-link")
      end

      def open_new_custom_section
        find("button.add-section").click
      end

      def edit_custom_section(name)
        find(".sidebar-section[data-section-name='#{name.parameterize}']").hover

        find(
          ".sidebar-section[data-section-name='#{name.parameterize}'] button.sidebar-section-header-button",
        ).click
      end

      SIDEBAR_SECTION_LINK_SELECTOR = "sidebar-section-link"

      def click_section_link(name)
        find(".#{SIDEBAR_SECTION_LINK_SELECTOR}", text: name).click
      end

      def has_one_active_section_link?
        has_css?(".#{SIDEBAR_SECTION_LINK_SELECTOR}--active", count: 1)
      end

      def has_section_link?(name, href: nil, active: false)
        attributes = {}
        attributes[:href] = href if href
        attributes[:class] = SIDEBAR_SECTION_LINK_SELECTOR
        attributes[:class] += "--active" if active
        has_link?(name, **attributes)
      end

      def custom_section_modal_title
        find("#discourse-modal-title")
      end

      def has_section?(name)
        find(".sidebar-wrapper").has_button?(name)
      end
    end
  end
end
