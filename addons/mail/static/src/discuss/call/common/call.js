/* @odoo-module */

import { CallActionList } from "@mail/discuss/call/common/call_action_list";
import { CallParticipantCard } from "@mail/discuss/call/common/call_participant_card";
import { isEventHandled, markEventHandled } from "@web/core/utils/misc";

import {
    Component,
    onMounted,
    onPatched,
    onWillUnmount,
    useExternalListener,
    useRef,
    useState,
} from "@odoo/owl";

import { browser } from "@web/core/browser/browser";
import { _t } from "@web/core/l10n/translation";
import { useService } from "@web/core/utils/hooks";

/**
 * @typedef CardData
 * @property {string} key
 * @property {import("@mail/discuss/call/common/rtc_session_model").RtcSession} session
 * @property {MediaStream} videoStream
 * @property {import("@mail/core/common/channel_member_model").ChannelMember} [member]
 */

/**
 * @typedef {Object} Props
 * @property {import("@mail/core/common/thread_model").Thread} thread
 * @property {boolean} [compact]
 * @extends {Component<Props, Env>}
 */
export class Call extends Component {
    static components = { CallActionList, CallParticipantCard };
    static props = ["thread", "compact?"];
    static template = "discuss.Call";

    overlayTimeout;

    setup() {
        this.grid = useRef("grid");
        this.notification = useService("notification");
        this.rtc = useState(useService("discuss.rtc"));
        this.state = useState({
            isFullscreen: false,
            sidebar: false,
            tileWidth: 0,
            tileHeight: 0,
            columnCount: 0,
            overlay: false,
            /** @type {CardData|undefined} */
            insetCard: undefined,
        });
        this.store = useState(useService("mail.store"));
        this.userSettings = useState(useService("mail.user_settings"));
        onMounted(() => {
            this.resizeObserver = new ResizeObserver(() => this.arrangeTiles());
            this.resizeObserver.observe(this.grid.el);
            this.arrangeTiles();
        });
        onPatched(() => this.arrangeTiles());
        onWillUnmount(() => {
            this.resizeObserver.disconnect();
            browser.clearTimeout(this.overlayTimeout);
        });
        useExternalListener(browser, "fullscreenchange", this.onFullScreenChange);
    }

    get isActiveCall() {
        return Boolean(this.props.thread.eq(this.rtc.state?.channel));
    }

    get minimized() {
        if (this.state.isFullscreen || this.props.compact || this.props.thread.activeRtcSession) {
            return false;
        }
        if (!this.isActiveCall || this.props.thread.videoCount === 0) {
            return true;
        }
        return false;
    }

    /** @returns {CardData[]} */
    get visibleCards() {
        const raisingHandCards = [];
        const sessionCards = [];
        const invitationCards = [];
        const filterVideos = this.props.thread.showOnlyVideo && this.props.thread.videoCount > 0;
        for (const session of Object.values(this.props.thread.rtcSessions)) {
            const target = session.raisingHand ? raisingHandCards : sessionCards;
            const cameraStream = session.videoStreams.get("camera");
            if (!filterVideos || cameraStream) {
                target.push({
                    key: "session_main_" + session.id,
                    session,
                    videoStream: cameraStream,
                });
            }
            const screenStream = session.videoStreams.get("screen");
            if (screenStream) {
                target.push({
                    key: "session_secondary_" + session.id,
                    session,
                    videoStream: screenStream,
                });
            }
        }
        if (!filterVideos) {
            for (const memberId of this.props.thread.invitedMemberIds) {
                invitationCards.push({
                    key: "member_" + memberId,
                    member: this.store.ChannelMember.get(memberId),
                });
            }
        }
        raisingHandCards.sort((c1, c2) => {
            return c1.session.raisingHand - c2.session.raisingHand;
        });
        sessionCards.sort((c1, c2) => {
            return (
                c1.session.channelMember?.persona?.name?.localeCompare(
                    c2.session.channelMember?.persona?.name
                ) ?? 1
            );
        });
        invitationCards.sort((c1, c2) => {
            return c1.member.persona?.name?.localeCompare(c2.member.persona?.name) ?? 1;
        });
        return raisingHandCards.concat(sessionCards, invitationCards);
    }

    /** @returns {CardData[]} */
    get visibleMainCards() {
        const activeSession = this.props.thread.activeRtcSession;
        if (!activeSession) {
            this.state.insetCard = undefined;
            return this.visibleCards;
        }
        switch (activeSession.videoStreams.size) {
            case 1:
                if (activeSession.videoStreams.get("screen") === activeSession.mainVideoStream) {
                    this.setInset(activeSession);
                }
                if (
                    activeSession.videoStreams.get("camera") &&
                    activeSession.videoStreams.get("camera") === activeSession.mainVideoStream
                ) {
                    this.state.insetCard = undefined;
                }
                if (!activeSession.mainVideoStream && activeSession.videoStreams.get("screen")) {
                    this.setInset(activeSession, "screen");
                }
                break;
            case 2: {
                const videoType =
                    activeSession.videoStreams.get("screen") === activeSession.mainVideoStream
                        ? "camera"
                        : "screen";
                this.setInset(activeSession, videoType);
                break;
            }
        }

        return [
            {
                key: "session_" + activeSession.id,
                session: activeSession,
                videoStream: activeSession.mainVideoStream,
            },
        ];
    }

    /**
     * @param {RtcSession} session
     * @param {String} videoType
     */
    setInset(session, videoType) {
        this.state.insetCard = {
            key: "session_" + session.id,
            session,
            videoStream: session.videoStreams.get(videoType),
        };
    }

    get hasCallNotifications() {
        return Boolean(
            (!this.props.compact || this.state.isFullscreen) &&
                this.isActiveCall &&
                this.rtc.notifications.size
        );
    }

    get hasSidebarButton() {
        return Boolean(
            this.props.thread.activeRtcSession && this.state.overlay && !this.props.compact
        );
    }

    get isControllerFloating() {
        return (
            this.state.isFullscreen || (this.props.thread.activeRtcSession && !this.props.compact)
        );
    }

    onMouseleaveMain(ev) {
        if (ev.relatedTarget && ev.relatedTarget.closest(".o-discuss-Call-overlay")) {
            // the overlay should not be hidden when the cursor leaves to enter the controller popover
            return;
        }
        this.state.overlay = false;
    }

    onMousemoveMain(ev) {
        if (isEventHandled(ev, "CallMain.MousemoveOverlay")) {
            return;
        }
        this.showOverlay();
    }

    onMousemoveOverlay(ev) {
        markEventHandled(ev, "CallMain.MousemoveOverlay");
        this.state.overlay = true;
        browser.clearTimeout(this.overlayTimeout);
    }

    showOverlay() {
        this.state.overlay = true;
        browser.clearTimeout(this.overlayTimeout);
        this.overlayTimeout = browser.setTimeout(() => {
            this.state.overlay = false;
        }, 3000);
    }

    arrangeTiles() {
        if (!this.grid.el) {
            return;
        }
        const { width, height } = this.grid.el.getBoundingClientRect();
        const aspectRatio = this.minimized ? 1 : 16 / 9;
        const tileCount = this.grid.el.children.length;
        let optimal = {
            area: 0,
            columnCount: 0,
            tileHeight: 0,
            tileWidth: 0,
        };
        for (let columnCount = 1; columnCount <= tileCount; columnCount++) {
            const rowCount = Math.ceil(tileCount / columnCount);
            const potentialHeight = width / (columnCount * aspectRatio);
            const potentialWidth = height / rowCount;
            let tileHeight;
            let tileWidth;
            if (potentialHeight > potentialWidth) {
                tileHeight = Math.floor(potentialWidth);
                tileWidth = Math.floor(tileHeight * aspectRatio);
            } else {
                tileWidth = Math.floor(width / columnCount);
                tileHeight = Math.floor(tileWidth / aspectRatio);
            }
            const area = tileHeight * tileWidth;
            if (area <= optimal.area) {
                continue;
            }
            optimal = {
                area,
                columnCount,
                tileHeight,
                tileWidth,
            };
        }
        Object.assign(this.state, {
            tileWidth: optimal.tileWidth,
            tileHeight: optimal.tileHeight,
            columnCount: optimal.columnCount,
        });
    }

    async enterFullScreen() {
        const el = document.body;
        try {
            if (el.requestFullscreen) {
                await el.requestFullscreen();
            } else if (el.mozRequestFullScreen) {
                await el.mozRequestFullScreen();
            } else if (el.webkitRequestFullscreen) {
                await el.webkitRequestFullscreen();
            }
            this.state.isFullscreen = true;
        } catch {
            this.state.isFullscreen = false;
            this.notification.add(_t("The Fullscreen mode was denied by the browser"), {
                type: "warning",
            });
        }
    }

    async exitFullScreen() {
        const fullscreenElement = document.webkitFullscreenElement || document.fullscreenElement;
        if (fullscreenElement) {
            if (document.exitFullscreen) {
                await document.exitFullscreen();
            } else if (document.mozCancelFullScreen) {
                await document.mozCancelFullScreen();
            } else if (document.webkitCancelFullScreen) {
                await document.webkitCancelFullScreen();
            }
        }
        this.state.isFullscreen = false;
    }

    /**
     * @private
     */
    onFullScreenChange() {
        this.state.isFullscreen = Boolean(
            document.webkitFullscreenElement || document.fullscreenElement
        );
    }
}
