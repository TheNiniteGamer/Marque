sub init()
    m.title = m.top.findNode("title")
    m.status = m.top.findNode("status")
    m.list = m.top.findNode("list")
    m.ask = m.top.findNode("ask")
    m.seasons = []
    m.ask.buttons = ["Ask for these seasons"]
    m.ask.observeField("selected", "onAsk")
    m.top.observeField("focusedChild", "onFocusChange")
end sub

sub onFocusChange()
    if m.top.hasFocus() then focusList()
end sub

' The highlight goes on the seasons once they're listed (until then the screen keeps it).
sub focusList()
    if m.seasons.Count() > 0 and not m.list.hasFocus() and not m.ask.hasFocus() then m.list.setFocus(true)
end sub

sub onParams()
    m.title.text = "More seasons of " + mqStr(m.top.params.title)
    m.status.text = "Loading…"
    load()
end sub

sub load()
    mqApi("/api/shows/" + m.top.params.id + "/seasons", "onLoaded")
end sub

sub onLoaded(event as Object)
    r = event.getData()
    if r.status <> 200 or r.data = invalid then
        m.status.text = "Can't load the seasons: " + r.error
        return
    end if
    m.seasons = []
    here = []
    root = CreateObject("roSGNode", "ContentNode")
    for each s in r.data.seasons
        n = mqNum(s.season)
        all = s.episodes <> invalid and mqNum(s.here) >= mqNum(s.episodes)
        if n >= 1 and all then
            here.Push(Int(n).ToStr())
        else if n >= 1 then
            m.seasons.Push(s)
            c = root.createChild("ContentNode")
            label = mqStr(s.name)
            if label = "" then label = "Season " + Int(n).ToStr()
            if mqIsTrue(s.asked) then
                label = label + "  ·  asked for already"
            else if mqNum(s.here) > 0 then
                label = label + "  ·  " + mqStr(s.here) + " of " + mqStr(s.episodes) + " here"
            else if s.episodes <> invalid then
                label = label + "  ·  " + mqStr(s.episodes) + " episodes"
            end if
            c.title = label
        end if
    end for
    m.list.content = root
    m.ask.visible = m.seasons.Count() > 0
    if m.seasons.Count() = 0 then
        m.status.text = "Every season is here already."
    else
        text = "Tick the seasons you'd like (OK), then Ask."
        if here.Count() > 0 then text = text + " Here already: season " + here.Join(", ") + "."
        m.status.text = text
    end if
    if m.notice <> invalid then m.status.text = m.notice
    m.notice = invalid
    if m.top.isInFocusChain() then focusList()
end sub

sub onAsk()
    picked = []
    states = m.list.checkedState
    for i = 0 to m.seasons.Count() - 1
        if states <> invalid and i < states.Count() then
            if mqIsTrue(states[i]) then picked.Push(m.seasons[i].season)
        end if
    end for
    if picked.Count() = 0 then
        m.status.text = "Tick a season first (OK on it), then Ask."
        m.list.setFocus(true)
        return
    end if
    m.status.text = "Asking…"
    mqApi("/api/requests", "onAsked", "POST", { showId: m.top.params.id, seasons: picked })
end sub

sub onAsked(event as Object)
    r = event.getData()
    if r.status <> 200 or r.data = invalid then
        m.status.text = r.error
        return
    end if
    if mqIsTrue(r.data.sent) then m.notice = "They're on their way. You'll get a notification when they're here." else m.notice = "Asked. You'll get a notification when they're here."
    ' (Listed again, now showing them as asked for.)
    m.top.setFocus(true)
    load()
end sub

function onKeyEvent(key as String, press as Boolean) as Boolean
    if not press then return false
    if key = "right" and m.list.hasFocus() and m.ask.visible then
        m.ask.setFocus(true)
        return true
    end if
    if key = "left" and m.ask.hasFocus() and m.seasons.Count() > 0 then
        m.list.setFocus(true)
        return true
    end if
    return false
end function
