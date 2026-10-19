sub init()
    m.video = m.top.findNode("video")
    m.skip = m.top.findNode("skip")
    m.upNext = m.top.findNode("upNext")
    m.nextTitle = m.top.findNode("nextTitle")
    m.message = m.top.findNode("message")
    m.reportTimer = m.top.findNode("reportTimer")
    m.nextTimer = m.top.findNode("nextTimer")
    m.video.notificationInterval = 1
    m.video.observeField("state", "onState")
    m.video.observeField("position", "onPosition")
    m.reportTimer.observeField("fire", "onReportTimer")
    m.nextTimer.observeField("fire", "playNext")
    m.top.observeField("focusedChild", "onFocusChange")
    m.started = false
    m.done = false
    m.mode = ""
    m.message.text = "Loading…"
end sub

sub onFocusChange()
    if m.top.hasFocus() then m.video.setFocus(true)
end sub

sub onParams()
    id = m.top.params.id
    mqApi("/api/items/" + id, "onItem")
    mqApi("/api/items/" + id + "/playback", "onPlayback")
end sub

sub onItem(event as Object)
    r = event.getData()
    if r.status <> 200 or r.data = invalid then
        m.message.text = "Can't play this: " + r.error
        return
    end if
    m.item = r.data
    start()
end sub

sub onPlayback(event as Object)
    r = event.getData()
    if r.status <> 200 or r.data = invalid then
        m.message.text = "Can't play this: " + r.error
        return
    end if
    m.pb = r.data
    start()
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
    m.message.text = ""
    x = m.item
    c = CreateObject("roSGNode", "ContentNode")
    title = mqStr(x.title)
    if x.type = "episode" then title = mqStr(x.showTitle) + " · " + mqEpLabel(x) + " · " + title
    c.title = title
    if canPlayDirectly(x) then
        c.url = mqMediaUrl("/api/items/" + x.id + "/stream")
        c.streamFormat = "mp4"
        m.mode = "direct"
    else
        c.url = mqMediaUrl("/api/items/" + x.id + "/hls/master.m3u8?sid=" + mqStr(m.pb.sid))
        c.streamFormat = "hls"
        m.mode = "hls"
    end if
    startAt = mqNum(m.top.params.start)
    if startAt < 0 then
        startAt = 0
        p = x.progress
        if p <> invalid and not mqIsTrue(p.watched) and mqNum(p.position) > 15 then startAt = mqNum(p.position)
    end if
    if startAt > 0 then c.PlayStart = startAt
    ' Subtitles (text ones; picture subtitles need the server to draw them, which the web player does).
    tracks = []
    if x.subtitles <> invalid then
        for each s in x.subtitles
            if s.burn = invalid then
                lang = mqStr(s.lang)
                if lang = "" then lang = "und"
                tracks.Push({ Language: lang, TrackName: mqMediaUrl("/api/items/" + x.id + "/subtitles/" + s.id + ".vtt"), Description: mqStr(s.label) })
            end if
        end for
    end if
    if tracks.Count() > 0 then c.SubtitleTracks = tracks
    m.video.content = c
    m.video.control = "play"
    m.video.setFocus(true)
    m.reportTimer.control = "start"
end sub

sub onState()
    s = m.video.state
    if s = "paused" then
        report(false)
    else if s = "finished" then
        report(true)
        finished()
    else if s = "error" then
        m.message.text = "This video can't be played: " + mqStr(m.video.errorMsg)
        report(true)
    end if
end sub

sub onPosition()
    intro = invalid
    if m.item <> invalid then intro = m.item.intro
    at = m.video.position
    inIntro = intro <> invalid and at >= mqNum(intro.start) and at < mqNum(intro.end) - 1
    m.skip.visible = inIntro
end sub

sub onReportTimer()
    if m.video.state = "playing" then report(false)
end sub

sub report(stopped as Boolean)
    if m.item = invalid or m.done then return
    at = m.video.position
    if at <= 0 and not stopped then return
    if stopped then m.done = true
    mqApi("/api/items/" + m.item.id + "/progress", "onReported", "POST", { position: at, paused: m.video.state = "paused", stopped: stopped, client: "Roku", mode: m.mode })
end sub

sub onReported()
end sub

' Stop converting now instead of when the server notices nobody is watching.
sub endConversion()
    if m.mode = "hls" and m.pb <> invalid then mqApi("/api/hls/" + mqStr(m.pb.sid), "onReported", "DELETE")
end sub

sub finished()
    m.reportTimer.control = "stop"
    nxt = m.item.next
    if nxt <> invalid then
        m.nextTitle.text = mqEpLabel(nxt) + " · " + mqStr(nxt.title)
        m.upNext.visible = true
        m.nextTimer.control = "start"
    else
        endConversion()
        m.top.navigate = { back: true }
    end if
end sub

sub playNext()
    nxt = m.item.next
    if nxt = invalid then return
    m.nextTimer.control = "stop"
    endConversion()
    m.top.navigate = { screen: "PlayerScreen", params: { id: nxt.id, start: 0 }, replace: true }
end sub

function onKeyEvent(key as String, press as Boolean) as Boolean
    if not press then return false
    if key = "back" then
        report(true)
        m.reportTimer.control = "stop"
        m.nextTimer.control = "stop"
        m.video.control = "stop"
        endConversion()
        m.top.navigate = { back: true }
        return true
    end if
    if key = "up" and m.skip.visible then
        m.video.seek = mqNum(m.item.intro.end)
        m.skip.visible = false
        return true
    end if
    if key = "OK" and m.upNext.visible then
        playNext()
        return true
    end if
    return false
end function
