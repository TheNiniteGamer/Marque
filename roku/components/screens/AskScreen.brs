sub init()
    m.title = m.top.findNode("title")
    m.kinds = m.top.findNode("kinds")
    m.status = m.top.findNode("status")
    m.results = m.top.findNode("results")
    m.found = []
    m.kind = "movie"
    m.kinds.buttons = ["Films", "TV shows"]
    m.kinds.observeField("selected", "onKind")
    m.results.observeField("itemSelected", "onPicked")
    m.top.observeField("focusedChild", "onFocusChange")
end sub

sub onFocusChange()
    if m.top.hasFocus() then m.kinds.setFocus(true)
end sub

sub onParams()
    m.q = mqStr(m.top.params.q)
    m.title.text = "Ask for “" + m.q + "”"
    search()
end sub

sub onKind()
    if m.kinds.selected = 1 then m.kind = "show" else m.kind = "movie"
    ' (The kind being shown stays white while you're in the results.)
    m.kinds.rest = m.kinds.selected
    search()
end sub

sub search()
    m.status.text = "Looking…"
    m.results.content = invalid
    m.found = []
    mqApi("/api/requests/search?kind=" + m.kind + "&q=" + mqEscape(m.q), "onResults")
end sub

sub onResults(event as Object)
    r = event.getData()
    notice = m.notice
    m.notice = invalid
    if r.status <> 200 or r.data = invalid then
        m.status.text = r.error
        return
    end if
    m.found = []
    root = CreateObject("roSGNode", "ContentNode")
    for each x in r.data.results
        m.found.Push(x)
        c = root.createChild("ContentNode")
        c.title = mqStr(x.title)
        if x.year <> invalid then c.title = c.title + " (" + mqStr(x.year) + ")"
        c.HDPosterUrl = mqStr(x.thumb)
        c.description = mqStr(x.overview)
        c.addFields({ progress: 0.0, sub: stateOf(x) })
    end for
    ' Not found online (or searching isn't set up): ask for it by its name.
    m.found.Push({ byName: true })
    c = root.createChild("ContentNode")
    c.title = "Ask for “" + m.q + "” by name"
    c.description = "If it isn't listed: whoever runs the server will look for it."
    c.addFields({ progress: 0.0, sub: "" })
    m.results.content = root
    if m.keepAt <> invalid and m.keepAt < root.getChildCount() then m.results.jumpToItem = m.keepAt
    m.keepAt = invalid
    if notice <> invalid then
        m.status.text = notice
    else if r.data.unavailable <> invalid then
        m.status.text = "Searching online isn't available, but you can ask for it by name."
    else if r.data.results.Count() = 0 then
        m.status.text = "Nothing found online with that name."
    else
        m.status.text = "Choose one to ask for it. You'll get a notification when it's here."
    end if
end sub

function stateOf(x as Object) as String
    if x.inLibrary <> invalid then return "Already here"
    if x.request <> invalid then
        st = { pending: "Waiting", approved: "On its way", available: "Here" }[mqStr(x.request.status)]
        if st <> invalid then return st + " · Me too"
    end if
    return "Ask for it"
end function

sub onPicked()
    x = m.found[m.results.itemSelected]
    if x = invalid then return
    if mqIsTrue(x.byName) then
        body = { kind: m.kind, title: m.q }
    else if x.inLibrary <> invalid then
        k = "movie"
        if m.kind = "show" then k = "show"
        m.top.navigate = { screen: "DetailsScreen", params: { id: x.inLibrary.id, kind: k } }
        return
    else
        body = { kind: m.kind, title: x.title, year: x.year, provider: x.provider, providerId: mqStr(x.id), thumb: x.thumb, overview: x.overview }
    end if
    m.status.text = "Asking…"
    mqApi("/api/requests", "onAsked", "POST", body)
end sub

sub onAsked(event as Object)
    r = event.getData()
    if r.status <> 200 or r.data = invalid then
        m.status.text = r.error
        return
    end if
    if mqIsTrue(r.data.sent) then
        m.notice = mqStr(r.data.title) + " is on its way. You'll get a notification when it's here."
    else
        m.notice = "Asked for " + mqStr(r.data.title) + ". You'll get a notification when it's here."
    end if
    keep = m.results.itemFocused
    search()
    m.keepAt = keep
end sub

function onKeyEvent(key as String, press as Boolean) as Boolean
    if not press then return false
    if key = "down" and m.kinds.hasFocus() and m.found.Count() > 0 then
        m.results.setFocus(true)
        return true
    end if
    if key = "up" and m.results.hasFocus() then
        m.kinds.setFocus(true)
        return true
    end if
    return false
end function
