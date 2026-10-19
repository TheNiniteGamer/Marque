' Keys: OK / ▶‖ play and pause · left/right (and ◀◀ ▶▶) scrub, held to go faster · Down to the
' buttons (Episodes, Audio & Subtitles, Next Episode) · Up or OK skips the intro · Back leaves.

sub init()
    m.video = m.top.findNode("video")
    m.spinner = m.top.findNode("spinner")
    m.spin = m.top.findNode("spin")
    m.overlay = m.top.findNode("overlay")
    m.heading = m.top.findNode("heading")
    m.subheading = m.top.findNode("subheading")
    m.bigPlay = m.top.findNode("bigPlay")
    m.preview = m.top.findNode("preview")
    m.previewFrame = m.top.findNode("previewFrame")
    m.previewClip = m.top.findNode("previewClip")
    m.previewSheet = m.top.findNode("previewSheet")
    m.previewTime = m.top.findNode("previewTime")
    m.played = m.top.findNode("played")
    m.knob = m.top.findNode("knob")
    m.remaining = m.top.findNode("remaining")
    m.ctlPlay = m.top.findNode("ctlPlay")
    m.actions = m.top.findNode("actions")
    m.leftActions = m.top.findNode("leftActions")
    m.skipText = m.top.findNode("skipText")
    m.skipFadeOut = m.top.findNode("skipFadeOut")
    m.nextFadeOut = m.top.findNode("nextFadeOut")
    m.toast = m.top.findNode("toast")
    m.toastTimer = m.top.findNode("toastTimer")
    m.skip = m.top.findNode("skip")
    m.upNext = m.top.findNode("upNext")
    m.idle = m.top.findNode("idle")
    m.panel = m.top.findNode("panel")
    m.audioList = m.top.findNode("audioList")
    m.subList = m.top.findNode("subList")
    m.message = m.top.findNode("message")
    m.hideTimer = m.top.findNode("hideTimer")
    m.holdTimer = m.top.findNode("holdTimer")
    m.commitTimer = m.top.findNode("commitTimer")
    m.idleTimer = m.top.findNode("idleTimer")
    m.countTimer = m.top.findNode("countTimer")
    m.reportTimer = m.top.findNode("reportTimer")

    m.barWidth = 1560
    m.video.notificationInterval = 0.5
    m.video.observeField("state", "onState")
    m.video.observeField("position", "onPosition")
    m.reportTimer.observeField("fire", "onReportTimer")
    m.hideTimer.observeField("fire", "hideOverlay")
    m.holdTimer.observeField("fire", "onHold")
    m.commitTimer.observeField("fire", "commitScrub")
    m.idleTimer.observeField("fire", "showIdle")
    m.countTimer.observeField("fire", "onCountdown")
    m.toastTimer.observeField("fire", "hideToast")
    m.skipFadeOut.observeField("state", "onSkipFaded")
    m.nextFadeOut.observeField("state", "onNextFaded")
    m.audioList.observeField("checkedItem", "onAudioPicked")
    m.subList.observeField("checkedItem", "onSubtitlePicked")
    m.top.observeField("focusedChild", "onFocusChange")
    if not m.global.hasField("autoNexts") then m.global.addFields({ autoNexts: 0 })

    m.started = false
    m.done = false
    m.mode = ""
    m.audio = 0
    m.burn = invalid
    m.scrubbing = false
    m.zone = "bar"
    m.ctlIndex = 1
    m.ctls = []
    m.upNextShown = false
    m.upNextDismissed = false
    m.upNextIndex = 0
    m.tp = invalid
    m.tpAskedAt = -1000
    m.prefs = { autoplayNext: true, autoSkipIntro: false, skipFade: 10 }
    m.skipPart = ""
    m.skipSince = 0
    m.autoSkipped = false
    m.clock = CreateObject("roTimespan")
    m.spin.control = "start"
end sub

sub onFocusChange()
    if m.panel.visible and m.top.hasFocus() then m.panelList.setFocus(true)
end sub

sub onParams()
    id = m.top.params.id
    mqApi("/api/items/" + id, "onItem")
    mqApi("/api/items/" + id + "/playback", "onPlayback")
    mqApi("/api/items/" + id + "/trickplay", "onTrickplay")
end sub

sub onItem(event as Object)
    r = event.getData()
    if r.status <> 200 or r.data = invalid then
        fail("Can't play this: " + r.error)
        return
    end if
    m.item = r.data
    start()
end sub

sub onPlayback(event as Object)
    r = event.getData()
    if r.status <> 200 or r.data = invalid then
        fail("Can't play this: " + r.error)
        return
    end if
    m.pb = r.data
    ' Player settings from the account (Account → Player on the web).
    p = m.pb.prefs
    if p <> invalid then
        if p.autoplayNext <> invalid then m.prefs.autoplayNext = mqIsTrue(p.autoplayNext)
        if p.autoSkipIntro <> invalid then m.prefs.autoSkipIntro = mqIsTrue(p.autoSkipIntro)
        if p.skipFade <> invalid then m.prefs.skipFade = mqNum(p.skipFade)
    end if
    start()
end sub

sub onTrickplay(event as Object)
    r = event.getData()
    if r.status = 200 and r.data <> invalid and mqIsTrue(r.data.ready) then m.tp = r.data
end sub

sub fail(text as String)
    m.spin.control = "stop"
    m.spinner.visible = false
    m.message.text = text + Chr(10) + Chr(10) + "Press Back to return."
end sub

' MP4 files with video and sound the Roku decodes play as they are; everything else is converted.
function canPlayDirectly(x as Object) as Boolean
    md = x.media
    if md = invalid then return false
    container = LCase(mqStr(md.container))
    if Instr(1, container, "mp4") = 0 and Instr(1, container, "mov") = 0 then return false
    v = md.video
    if v = invalid then return false
    vc = LCase(mqStr(v.codec))
    if vc = "hevc" then
        info = CreateObject("roDeviceInfo").CanDecodeVideo({ Codec: "hevc" })
        if info = invalid or not mqIsTrue(info.Result) then return false
    else if vc <> "h264" then
        return false
    end if
    if md.audio <> invalid and md.audio.Count() > 0 then
        ac = LCase(mqStr(md.audio[0].codec))
        if ac <> "aac" and ac <> "ac3" and ac <> "eac3" and ac <> "mp3" then return false
    end if
    return true
end function

sub start()
    if m.item = invalid or m.pb = invalid or m.started then return
    m.started = true
    x = m.item
    if x.type = "episode" then
        m.heading.text = mqStr(x.showTitle)
        m.subheading.text = mqEpLabel(x) + "  " + mqStr(x.title)
    else
        m.heading.text = mqStr(x.title)
        m.subheading.text = mqStr(x.year)
    end if
    m.duration = mqNum(x.duration)
    if m.duration <= 0 and x.media <> invalid then m.duration = mqNum(x.media.duration)
    if canPlayDirectly(x) then m.mode = "direct" else m.mode = "hls"

    startAt = mqNum(m.top.params.start)
    if startAt < 0 then
        startAt = 0
        p = x.progress
        if p <> invalid and not mqIsTrue(p.watched) and mqNum(p.position) > 15 then startAt = mqNum(p.position)
    end if

    ' Subtitles: text ones go to the Roku's own subtitle display; picture ones are drawn in by the server.
    m.subs = []
    m.subTracks = []
    if x.subtitles <> invalid then
        for each s in x.subtitles
            m.subs.Push(s)
            if s.burn = invalid then
                lang = mqStr(s.lang)
                if lang = "" then lang = "und"
                m.subTracks.Push({ Language: lang, TrackName: mqMediaUrl("/api/items/" + x.id + "/subtitles/" + s.id + ".vtt"), Description: mqStr(s.label) })
            end if
        end for
    end if
    m.subOn = invalid
    buildActions()
    load(startAt)
    m.reportTimer.control = "start"
    ' The subtitle language picked last time, if this has it.
    want = mqRead("subLang")
    if want <> "" then
        for i = 0 to m.subs.Count() - 1
            if m.subs[i].burn = invalid and mqStr(m.subs[i].lang) = want then
                setSubtitle(i)
                exit for
            end if
        end for
    end if
    if m.subOn = invalid then m.video.globalCaptionMode = "Off"
end sub

' (Re)loads the stream at a position: on start, and when the sound track or drawn-in subtitles change.
sub load(at as Float)
    x = m.item
    c = CreateObject("roSGNode", "ContentNode")
    c.title = m.heading.text
    if m.mode = "direct" then
        c.url = mqMediaUrl("/api/items/" + x.id + "/stream")
        c.streamFormat = "mp4"
    else
        q = "?sid=" + mqStr(m.pb.sid) + "&audio=" + m.audio.ToStr()
        if m.burn <> invalid then q = q + "&burn=" + mqStr(m.burn)
        c.url = mqMediaUrl("/api/items/" + x.id + "/hls/master.m3u8" + q)
        c.streamFormat = "hls"
    end if
    if at > 0 then c.PlayStart = at
    if m.subTracks.Count() > 0 then c.SubtitleTracks = m.subTracks
    m.video.content = c
    m.video.control = "play"
    m.subApplied = false
    showSpinner(true)
end sub

' ---------- state ----------

sub onState()
    s = m.video.state
    showSpinner(s = "buffering")
    if s = "playing" then
        m.message.text = ""
        m.ctlPlay.uri = "pkg:/images/pl_pause.png"
        m.bigPlay.visible = false
        m.idleTimer.control = "stop"
        if m.overlay.visible and not m.scrubbing then m.hideTimer.control = "start"
        if m.subOn <> invalid and not m.subApplied then applyTextSubtitle()
    else if s = "paused" then
        m.ctlPlay.uri = "pkg:/images/pl_play.png"
        m.bigPlay.visible = true
        report(false)
        m.idleTimer.control = "start"
    else if s = "finished" then
        report(true)
        finished()
    else if s = "error" then
        fail("This video can't be played: " + mqStr(m.video.errorMsg))
        report(true)
    end if
end sub

sub showSpinner(on as Boolean)
    m.spinner.visible = on
    if on then m.spin.control = "start" else m.spin.control = "stop"
end sub

sub onPosition()
    at = m.video.position
    if not m.scrubbing then drawBar(at)
    updateSkip(at)
    ' The next episode's card at the credits (or 20 s before the end when no credits were found).
    if m.item.next <> invalid and not m.upNextShown and not m.upNextDismissed and m.duration > 0 then
        creditsAt = m.duration - 20
        if m.item.credits <> invalid and mqNum(m.item.credits.start) > 0 then creditsAt = mqNum(m.item.credits.start)
        if at >= creditsAt and at < m.duration - 1 then showUpNext(false)
    end if
end sub

function duration() as Float
    if m.video.duration > 0 then return m.video.duration
    return m.duration
end function

sub drawBar(at as Float)
    d = duration()
    if d <= 0 then return
    f = at / d
    if f < 0 then f = 0
    if f > 1 then f = 1
    m.played.width = m.barWidth * f
    m.knob.translation = [m.barWidth * f - 16, -12]
    m.remaining.text = mqClock(d - at)
end sub

' ---------- the controls ----------

sub buildActions()
    ' Left to right: Episodes · back 10, play/pause, ahead 10 (centred) · Audio & Subtitles, Next Episode.
    m.ctls = []
    if m.item.type = "episode" and m.item.showId <> invalid then addAction(m.leftActions, "Episodes", "episodes")
    m.ctlIndex = m.ctls.Count() + 1
    m.ctls.Push({ kind: "icon", node: m.top.findNode("ctlBack"), action: "back10" })
    m.ctls.Push({ kind: "icon", node: m.ctlPlay, action: "play" })
    m.ctls.Push({ kind: "icon", node: m.top.findNode("ctlFwd"), action: "fwd10" })
    if m.subs.Count() > 0 or (m.item.audioTracks <> invalid and m.item.audioTracks.Count() > 1) then addAction(m.actions, "Audio & Subtitles", "tracks")
    if m.item.next <> invalid then addAction(m.actions, "Next Episode", "next")
    paintControls()
end sub

' A word button: highlighted as a white pill with dark text (as in the Android TV app).
sub addAction(row as Object, text as String, action as String)
    g = row.createChild("Group")
    pill = g.createChild("Poster")
    pill.uri = "pkg:/images/pill.9.png"
    pill.opacity = 0
    t = g.createChild("Label")
    t.font = "font:MediumBoldSystemFont"
    t.text = text
    w = t.boundingRect().width
    if w < 20 then w = Len(text) * 20
    pill.width = w + 48
    pill.height = 60
    t.translation = [24, 0]
    t.height = 60
    t.vertAlign = "center"
    m.ctls.Push({ kind: "text", node: g, label: t, pill: pill, action: action })
end sub

sub paintControls()
    iconOn = invalid
    for i = 0 to m.ctls.Count() - 1
        c = m.ctls[i]
        on = m.zone = "controls" and i = m.ctlIndex
        if c.kind = "icon" then
            if on then
                c.node.opacity = 1.0
                c.node.scale = [1.15, 1.15]
                iconOn = c.node
            else
                c.node.opacity = 0.75
                c.node.scale = [1.0, 1.0]
            end if
        else
            if on then
                c.pill.opacity = 1.0
                c.label.color = "0x000000FF"
            else
                c.pill.opacity = 0
                c.label.color = "0xC8C8C8FF"
            end if
        end if
    end for
    ' A light circle behind the highlighted icon.
    focusRing = m.top.findNode("iconFocus")
    if iconOn <> invalid then
        r = iconOn.sceneBoundingRect()
        focusRing.translation = [r.x + r.width / 2 - 44, r.y + r.height / 2 - 44]
        focusRing.visible = true
    else
        focusRing.visible = false
    end if
    if m.zone = "bar" then m.knob.scale = [1.3, 1.3] else m.knob.scale = [1.0, 1.0]
    m.knob.scaleRotateCenter = [16, 16]
end sub

sub showOverlay(zone = "" as String)
    hideIdle()
    if zone <> "" then m.zone = zone
    if not m.overlay.visible then
        m.overlay.visible = true
        drawBar(m.video.position)
    end if
    m.bigPlay.visible = m.video.state = "paused"
    paintControls()
    paintSkip()
    m.hideTimer.control = "stop"
    if m.video.state = "playing" and not m.scrubbing then m.hideTimer.control = "start"
end sub

sub hideOverlay()
    if m.scrubbing or m.video.state = "paused" then return
    m.overlay.visible = false
    m.zone = "bar"
    paintSkip()
end sub

sub togglePause()
    if m.video.state = "paused" then
        m.video.control = "resume"
    else if m.video.state = "playing" or m.video.state = "buffering" then
        m.video.control = "pause"
    end if
    showOverlay()
end sub

sub act(action as String)
    if action = "play" then
        togglePause()
    else if action = "back10" then
        jump(-10)
    else if action = "fwd10" then
        jump(10)
    else if action = "tracks" then
        openPanel()
    else if action = "next" then
        playNext(false)
    else if action = "episodes" then
        leave()
        m.top.navigate = { screen: "EpisodesScreen", params: { id: m.item.showId, title: mqStr(m.item.showTitle), season: m.item.season }, replace: true }
    end if
end sub

sub jump(by as Float)
    d = duration()
    t = m.video.position + by
    if t < 0 then t = 0
    if d > 0 and t > d - 2 then t = d - 2
    m.video.seek = t
    drawBar(t)
    showOverlay()
end sub

' ---------- scrubbing ----------

sub beginScrub(dir as Integer, fast as Boolean)
    if not m.scrubbing then
        m.scrubbing = true
        m.scrubPos = m.video.position
        m.wasPaused = m.video.state = "paused"
    end if
    m.holdDir = dir
    m.holdFast = fast
    m.holdTicks = 0
    m.commitTimer.control = "stop"
    showOverlay("bar")
    m.hideTimer.control = "stop"
    scrubStep()
    m.holdTimer.control = "start"
end sub

sub onHold()
    scrubStep()
end sub

sub scrubStep()
    m.holdTicks = m.holdTicks + 1
    size = 10
    if m.holdTicks > 4 then size = 30
    if m.holdTicks > 12 then size = 60
    if m.holdFast then size = size * 3
    d = duration()
    m.scrubPos = m.scrubPos + m.holdDir * size
    if m.scrubPos < 0 then m.scrubPos = 0
    if d > 0 and m.scrubPos > d - 2 then m.scrubPos = d - 2
    drawBar(m.scrubPos)
    showPreview(m.scrubPos)
end sub

sub endHold()
    m.holdTimer.control = "stop"
    if m.scrubbing then m.commitTimer.control = "start"
end sub

sub commitScrub()
    if not m.scrubbing then return
    m.holdTimer.control = "stop"
    m.commitTimer.control = "stop"
    m.scrubbing = false
    m.preview.visible = false
    m.video.seek = m.scrubPos
    if m.wasPaused then m.video.control = "resume"
    showOverlay()
end sub

' The picture at that time, from the server's preview sheets (10×10 pictures, one every 10 s).
sub showPreview(at as Float)
    m.previewTime.text = mqClock(at)
    tp = m.tp
    if tp = invalid and m.clock.TotalSeconds() - m.tpAskedAt > 30 then
        m.tpAskedAt = m.clock.TotalSeconds()
        mqApi("/api/items/" + m.item.id + "/trickplay", "onTrickplay")
    end if
    scale = 1.5
    w = 240
    h = 135
    if tp <> invalid then
        w = Int(mqNum(tp.width))
        h = Int(mqNum(tp.height))
        cols = Int(mqNum(tp.cols))
        rows = Int(mqNum(tp.rows))
        n = Int(at / mqNum(tp.interval))
        if n >= Int(mqNum(tp.count)) then n = Int(mqNum(tp.count)) - 1
        if n < 0 then n = 0
        per = cols * rows
        sheet = Int(n / per)
        idx = n - sheet * per
        col = idx mod cols
        row = Int(idx / cols)
        uri = mqMediaUrl("/api/items/" + m.item.id + "/trickplay/" + sheet.ToStr() + ".jpg")
        if m.previewSheet.uri <> uri then
            m.previewSheet.width = w * cols
            m.previewSheet.height = h * rows
            m.previewSheet.uri = uri
        end if
        m.previewSheet.translation = [-col * w, -row * h]
        m.previewClip.clippingRect = [0, 0, w, h]
        m.previewClip.scale = [scale, scale]
        m.previewClip.visible = true
        m.previewFrame.visible = true
    else
        m.previewClip.visible = false
        m.previewFrame.visible = false
    end if
    pw = w * scale + 6
    ph = h * scale + 6
    m.previewFrame.width = pw
    m.previewFrame.height = ph
    m.previewTime.width = pw
    m.previewTime.translation = [0, ph + 8]
    d = duration()
    f = 0.0
    if d > 0 then f = at / d
    x = 96 + m.barWidth * f - pw / 2
    if x < 60 then x = 60
    if x > 1860 - pw then x = 1860 - pw
    m.preview.translation = [x, 880 - ph - 70]
    m.preview.visible = true
end sub

' ---------- Skip Intro / Skip Credits, Up Next ----------

' "Skip Intro" during the intro, "Skip Credits" in a film's end credits (episodes get the Next Episode
' card). It fades after the account's skipFade seconds (0 = stays), and comes back with the controls.
sub updateSkip(at as Float)
    part = ""
    intro = m.item.intro
    if intro <> invalid and at >= mqNum(intro.start) and at < mqNum(intro.end) - 1 then part = "intro"
    credits = m.item.credits
    d = duration()
    if part = "" and m.item.next = invalid and credits <> invalid and mqNum(credits.start) > 0 and at >= mqNum(credits.start) and d > 0 and at < d - 2 then part = "credits"
    if part = "intro" and m.prefs.autoSkipIntro and not m.autoSkipped and m.video.state = "playing" then
        m.autoSkipped = true
        m.video.seek = mqNum(intro.end)
        toast("Skipped the intro")
        part = ""
    end if
    if part <> m.skipPart then
        m.skipPart = part
        m.skipSince = m.clock.TotalSeconds()
        if part = "intro" then m.skipText.text = "Skip Intro"
        if part = "credits" then m.skipText.text = "Skip Credits"
    end if
    paintSkip()
end sub

sub paintSkip()
    show = m.skipPart <> "" and not m.upNext.visible and not m.panel.visible
    fade = m.prefs.skipFade
    fresh = fade <= 0 or m.clock.TotalSeconds() - m.skipSince < fade
    if show and (fresh or m.overlay.visible) then
        m.skipFadeOut.control = "stop"
        m.skip.opacity = 1.0
        m.skip.visible = true
    else if show and m.skip.visible and m.skip.opacity >= 1.0 and m.skipFadeOut.state <> "running" then
        m.skipFadeOut.control = "start"
    else if not show then
        m.skipFadeOut.control = "stop"
        m.skip.visible = false
    end if
end sub

sub onSkipFaded()
    if m.skipFadeOut.state = "stopped" and m.skip.opacity < 0.05 then m.skip.visible = false
end sub

function skipShowing() as Boolean
    return m.skip.visible and m.skip.opacity > 0.5
end function

sub skipIntro()
    if m.skipPart = "credits" then
        ' Skipping a film's credits ends it (and counts it as watched).
        report(true, duration())
        leave()
        m.top.navigate = { back: true }
        return
    end if
    m.video.seek = mqNum(m.item.intro.end)
    m.skip.visible = false
end sub

sub toast(text as String)
    m.top.findNode("toastText").text = text
    m.toast.visible = true
    m.toastTimer.control = "start"
end sub

sub hideToast()
    m.toast.visible = false
end sub

sub showUpNext(stillWatching as Boolean)
    nxt = m.item.next
    if nxt = invalid then return
    m.upNextShown = true
    m.stillWatching = stillWatching
    m.top.findNode("nextThumb").uri = mqArt("thumb", nxt)
    m.top.findNode("nextKind").text = "NEXT EPISODE  ·  " + mqEpLabel(nxt)
    m.top.findNode("nextTitle").text = mqStr(nxt.title)
    m.upNextIndex = 0
    m.count = 10
    m.skip.visible = false
    m.overlay.visible = false
    m.nextFadeOut.control = "stop"
    m.upNext.opacity = 1.0
    m.upNext.visible = true
    m.autoplay = m.prefs.autoplayNext and not stillWatching
    paintUpNext()
    if m.autoplay then
        m.countTimer.control = "start"
    else if not stillWatching and m.prefs.skipFade > 0 then
        ' No countdown: the card fades like the skip buttons (Next Episode is also under the bar).
        m.count = Int(m.prefs.skipFade)
        m.countTimer.control = "start"
    end if
end sub

sub onNextFaded()
    if m.nextFadeOut.state = "stopped" and m.upNext.opacity < 0.05 then dismissUpNext()
end sub

sub paintUpNext()
    first = "Next Episode in " + m.count.ToStr()
    if not m.autoplay then first = "Next Episode"
    second = "Watch Credits"
    if m.stillWatching then
        m.top.findNode("nextKind").text = "ARE YOU STILL WATCHING?"
        first = "Continue Watching"
        second = "Back to browsing"
    end if
    texts = [first, second]
    for i = 0 to 1
        bg = m.top.findNode("nextBg" + i.ToStr())
        t = m.top.findNode("nextText" + i.ToStr())
        t.text = texts[i]
        if i = m.upNextIndex then
            bg.color = "0xFFFFFFFF"
            t.color = "0x000000FF"
        else
            bg.color = "0x3A3A3AFF"
            t.color = "0xFFFFFFFF"
        end if
    end for
end sub

sub onCountdown()
    m.count = m.count - 1
    if m.count <= 0 then
        m.countTimer.control = "stop"
        if m.autoplay then playNext(true) else m.nextFadeOut.control = "start"
    else
        paintUpNext()
    end if
end sub

sub dismissUpNext()
    m.countTimer.control = "stop"
    m.nextFadeOut.control = "stop"
    m.upNext.opacity = 1.0
    m.upNext.visible = false
    m.upNextDismissed = true
end sub

sub finished()
    m.reportTimer.control = "stop"
    if m.item.next <> invalid then
        ' Three episodes in a row with nobody touching the remote: ask first.
        if not m.prefs.autoplayNext then
            leave()
            m.top.navigate = { back: true }
        else if m.global.autoNexts >= 3 then
            showUpNext(true)
        else
            playNext(true)
        end if
    else
        leave()
        m.top.navigate = { back: true }
    end if
end sub

sub playNext(auto as Boolean)
    nxt = m.item.next
    if nxt = invalid then return
    if auto then
        if m.global.autoNexts >= 3 then
            showUpNext(true)
            return
        end if
        m.global.autoNexts = m.global.autoNexts + 1
    end if
    leave()
    m.top.navigate = { screen: "PlayerScreen", params: { id: nxt.id, start: 0 }, replace: true }
end sub

' ---------- paused for a while ----------

sub showIdle()
    if m.video.state <> "paused" or m.panel.visible or m.upNext.visible then return
    x = m.item
    m.top.findNode("idleTitle").text = m.heading.text
    if x.type = "episode" then m.top.findNode("idleSub").text = mqEpLabel(x) + "  " + mqStr(x.title) else m.top.findNode("idleSub").text = ""
    m.top.findNode("idleOverview").text = mqStr(x.overview)
    m.overlay.visible = false
    m.idle.visible = true
end sub

sub hideIdle()
    m.idle.visible = false
end sub

' ---------- Audio & Subtitles ----------

sub openPanel()
    m.applying = true
    a = CreateObject("roSGNode", "ContentNode")
    tracks = m.item.audioTracks
    if tracks = invalid or tracks.Count() = 0 then tracks = [{ label: "Original" }]
    for each t in tracks
        n = a.createChild("ContentNode")
        n.title = mqStr(t.label)
    end for
    m.audioList.content = a
    m.audioList.checkedItem = m.audio
    s = CreateObject("roSGNode", "ContentNode")
    n = s.createChild("ContentNode")
    n.title = "Off"
    for each sub_ in m.subs
        n = s.createChild("ContentNode")
        n.title = mqStr(sub_.label)
    end for
    m.subList.content = s
    if m.subOn = invalid then m.subList.checkedItem = 0 else m.subList.checkedItem = m.subOn + 1
    m.applying = false
    m.overlay.visible = false
    m.panel.visible = true
    m.panelList = m.subList
    if m.subs.Count() = 0 then m.panelList = m.audioList
    m.panelList.setFocus(true)
end sub

sub closePanel()
    m.panel.visible = false
    m.top.setFocus(true)
    showOverlay("controls")
end sub

sub onAudioPicked()
    if m.applying then return
    i = m.audioList.checkedItem
    if i = m.audio or m.item.audioTracks = invalid or i >= m.item.audioTracks.Count() then return
    m.audio = i
    avail = m.video.availableAudioTracks
    if m.mode = "direct" and avail <> invalid and avail.Count() = m.item.audioTracks.Count() then
        m.video.audioTrack = avail[i].Track
    else
        ' The server converts with the chosen sound track.
        m.mode = "hls"
        load(m.video.position)
    end if
end sub

sub onSubtitlePicked()
    if m.applying then return
    i = m.subList.checkedItem - 1
    if i < 0 then
        setSubtitle(-1)
        mqWrite("subLang", "")
    else
        setSubtitle(i)
        mqWrite("subLang", mqStr(m.subs[i].lang))
    end if
end sub

' -1: off. Text subtitles are shown by the Roku; picture ones need the stream reloaded with them drawn in.
sub setSubtitle(i as Integer)
    wasBurn = m.burn
    if i < 0 then
        m.subOn = invalid
        m.burn = invalid
        m.video.globalCaptionMode = "Off"
    else if m.subs[i].burn <> invalid then
        m.subOn = i
        m.burn = m.subs[i].burn
        m.video.globalCaptionMode = "Off"
    else
        m.subOn = i
        m.burn = invalid
        applyTextSubtitle()
    end if
    burnChanged = (wasBurn = invalid) <> (m.burn = invalid)
    if not burnChanged and wasBurn <> invalid and m.burn <> invalid then burnChanged = wasBurn <> m.burn
    if burnChanged and m.video.content <> invalid then
        m.mode = "hls"
        load(m.video.position)
    end if
end sub

sub applyTextSubtitle()
    if m.subOn = invalid or m.subs[m.subOn].burn <> invalid then return
    url = mqMediaUrl("/api/items/" + m.item.id + "/subtitles/" + m.subs[m.subOn].id + ".vtt")
    track = url
    avail = m.video.availableSubtitleTracks
    if avail <> invalid then
        for each a in avail
            if mqStr(a.TrackName) = url or (mqStr(a.Description) <> "" and mqStr(a.Description) = mqStr(m.subs[m.subOn].label)) then
                track = a.TrackName
                exit for
            end if
        end for
    end if
    m.video.subtitleTrack = track
    m.video.globalCaptionMode = "On"
    m.subApplied = true
end sub

' ---------- progress ----------

sub onReportTimer()
    if m.video.state = "playing" then report(false)
end sub

sub report(stopped as Boolean, position = -1 as Float)
    if m.item = invalid or m.done then return
    at = m.video.position
    if position >= 0 then at = position
    if at <= 0 and not stopped then return
    if stopped then m.done = true
    mqApi("/api/items/" + m.item.id + "/progress", "onReported", "POST", { position: at, paused: m.video.state = "paused", stopped: stopped, client: "Roku", mode: m.mode })
end sub

sub onReported()
end sub

' Stop everything before leaving the player.
sub leave()
    report(true)
    for each t in [m.reportTimer, m.hideTimer, m.holdTimer, m.commitTimer, m.idleTimer, m.countTimer]
        t.control = "stop"
    end for
    m.video.control = "stop"
    if m.mode = "hls" and m.pb <> invalid then mqApi("/api/hls/" + mqStr(m.pb.sid), "onReported", "DELETE")
end sub

' ---------- keys ----------

function onKeyEvent(key as String, press as Boolean) as Boolean
    if not press then
        if key = "left" or key = "right" or key = "fastforward" or key = "rewind" then
            endHold()
            return true
        end if
        return false
    end if
    m.global.autoNexts = 0

    if key = "back" then
        if m.panel.visible then
            closePanel()
            return true
        end if
        leave()
        m.top.navigate = { back: true }
        return true
    end if
    if m.item = invalid or not m.started then return true

    if m.panel.visible then
        if key = "left" and m.subList.hasFocus() then
            m.panelList = m.audioList
            m.audioList.setFocus(true)
        else if key = "right" and m.audioList.hasFocus() and m.subs.Count() > 0 then
            m.panelList = m.subList
            m.subList.setFocus(true)
        end if
        return true
    end if

    if m.idle.visible then
        hideIdle()
        if key = "OK" or key = "play" then togglePause() else showOverlay()
        return true
    end if

    if m.upNext.visible then
        if key = "up" or key = "down" or key = "left" or key = "right" then
            m.upNextIndex = 1 - m.upNextIndex
            paintUpNext()
            return true
        end if
        if key = "OK" then
            if m.upNextIndex = 0 then
                m.countTimer.control = "stop"
                playNext(false)
            else if m.stillWatching then
                leave()
                m.top.navigate = { back: true }
            else
                dismissUpNext()
            end if
            return true
        end if
    end if

    if key = "play" then
        togglePause()
        return true
    end if
    if key = "replay" then
        jump(-10)
        return true
    end if
    if key = "fastforward" or key = "rewind" then
        dir = 1
        if key = "rewind" then dir = -1
        beginScrub(dir, true)
        return true
    end if

    if not m.overlay.visible then
        if (key = "OK" or key = "up") and skipShowing() then
            skipIntro()
        else if key = "OK" then
            togglePause()
        else if key = "left" then
            beginScrub(-1, false)
        else if key = "right" then
            beginScrub(1, false)
        else if key = "down" then
            showOverlay("controls")
        else
            showOverlay("bar")
        end if
        return true
    end if

    if m.zone = "bar" then
        if key = "left" then
            beginScrub(-1, false)
        else if key = "right" then
            beginScrub(1, false)
        else if key = "OK" then
            if m.scrubbing then commitScrub() else togglePause()
        else if key = "down" then
            if m.scrubbing then commitScrub()
            m.zone = "controls"
            showOverlay()
        else if key = "up" then
            if m.skip.visible then
                skipIntro()
            else
                m.overlay.visible = false
            end if
        end if
        return true
    end if

    ' The buttons under the bar.
    if key = "left" and m.ctlIndex > 0 then
        m.ctlIndex = m.ctlIndex - 1
    else if key = "right" and m.ctlIndex < m.ctls.Count() - 1 then
        m.ctlIndex = m.ctlIndex + 1
    else if key = "up" then
        m.zone = "bar"
    else if key = "OK" then
        act(m.ctls[m.ctlIndex].action)
        return true
    end if
    showOverlay()
    return true
end function
