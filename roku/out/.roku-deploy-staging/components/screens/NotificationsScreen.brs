sub init()
    m.status = m.top.findNode("status")
    m.list = m.top.findNode("list")
    m.items = []
    m.list.observeField("itemSelected", "onPicked")
    m.top.observeField("focusedChild", "onFocusChange")
end sub

sub onFocusChange()
    if m.top.hasFocus() then m.list.setFocus(true)
end sub

sub onParams()
    m.status.text = "Loading…"
    mqApi("/api/notifications", "onLoaded")
end sub

sub onLoaded(event as Object)
    r = event.getData()
    if r.status <> 200 or r.data = invalid then
        m.status.text = "Can't load the notifications: " + r.error
        return
    end if
    m.items = []
    root = CreateObject("roSGNode", "ContentNode")
    ' Newest first.
    list = r.data.items
    for i = list.Count() - 1 to 0 step -1
        n = list[i]
        m.items.Push(n)
        c = root.createChild("ContentNode")
        c.title = mqStr(n.title)
        c.description = mqStr(n.body)
        ' The title it's about: its picture.
        target = linkTarget(mqStr(n.link))
        if target <> invalid and target.kind = "show" then c.HDPosterUrl = mqArt("backdrop", { id: target.id, artV: "" })
        if target <> invalid and target.kind = "item" then c.HDPosterUrl = mqArt("thumb", { id: target.id, artV: "" })
        sub_ = ""
        if not mqIsTrue(n.read) then sub_ = "New"
        c.addFields({ progress: 0.0, sub: sub_ })
    end for
    m.list.content = root
    if m.items.Count() = 0 then m.status.text = "Nothing new." else m.status.text = ""
    ' Seen now (as when the web's bell is opened).
    if mqNum(r.data.unread) > 0 then mqApi("/api/notifications/read", "onRead", "POST", {})
end sub

sub onRead()
end sub

' "#/show/<id>", "#/item/<id>" or "#/requests" (the web's addresses).
function linkTarget(link as String) as Dynamic
    q = Instr(1, link, "?")
    if q > 0 then link = Left(link, q - 1)
    if Left(link, 7) = "#/show/" then return { kind: "show", id: Mid(link, 8) }
    if Left(link, 7) = "#/item/" then return { kind: "item", id: Mid(link, 8) }
    if Left(link, 10) = "#/requests" then return { kind: "requests" }
    return invalid
end function

sub onPicked()
    n = m.items[m.list.itemSelected]
    if n = invalid then return
    t = linkTarget(mqStr(n.link))
    if t = invalid then return
    if t.kind = "requests" then
        m.top.navigate = { screen: "RequestsScreen", params: {} }
    else if t.kind = "show" then
        m.top.navigate = { screen: "DetailsScreen", params: { id: t.id, kind: "show" } }
    else
        m.top.navigate = { screen: "DetailsScreen", params: { id: t.id, kind: "item" } }
    end if
end sub
