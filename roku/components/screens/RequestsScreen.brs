sub init()
    m.status = m.top.findNode("status")
    m.list = m.top.findNode("list")
    m.menu = m.top.findNode("menu")
    m.items = []
    m.list.observeField("itemSelected", "onPicked")
    m.menu.observeField("chosen", "onMenuChosen")
    m.menu.observeField("closed", "onMenuClosed")
    m.top.observeField("focusedChild", "onFocusChange")
end sub

sub onFocusChange()
    if m.top.hasFocus() then m.list.setFocus(true)
end sub

sub onParams()
    m.status.text = "Loading…"
    load()
end sub

sub onRefresh()
    if m.top.refresh then load()
end sub

sub load()
    mqApi("/api/requests", "onLoaded")
end sub

sub onLoaded(event as Object)
    r = event.getData()
    if r.status <> 200 or r.data = invalid then
        m.status.text = "Can't load your requests: " + r.error
        return
    end if
    names = { pending: "Waiting for approval", approved: "On its way", declined: "Declined", available: "Here" }
    m.items = []
    root = CreateObject("roSGNode", "ContentNode")
    for each q in r.data.requests
        m.items.Push(q)
        c = root.createChild("ContentNode")
        c.title = mqStr(q.title)
        if q.seasons <> invalid and q.seasons.Count() > 0 then
            nums = []
            for each n in q.seasons
                nums.Push(mqStr(n))
            end for
            c.title = c.title + " · season " + nums.Join(", ")
        else if q.year <> invalid then
            c.title = c.title + " (" + mqStr(q.year) + ")"
        end if
        state = names[mqStr(q.status)]
        if state = invalid then state = mqStr(q.status)
        if q.progress <> invalid and mqStr(q.progress.label) <> "" then state = mqStr(q.progress.label)
        c.HDPosterUrl = mqStr(q.thumb)
        notes = []
        if mqIsTrue(q.firstHere) and q.status = "approved" then notes.Push("The first episodes are here; more on the way.")
        if mqStr(q.adminNote) <> "" then notes.Push("From the server: " + mqStr(q.adminNote))
        if mqStr(q.note) <> "" then notes.Push("Your note: " + mqStr(q.note))
        if notes.Count() = 0 then notes.Push(mqStr(q.overview))
        c.description = notes.Join(" ")
        c.addFields({ progress: 0.0, sub: state })
    end for
    m.list.content = root
    if m.items.Count() = 0 then
        m.status.text = "Nothing asked for yet. To ask for a film or show, search for it and choose Ask for it."
    else
        m.status.text = "Press * to withdraw one that's still waiting. New requests start from Search."
    end if
end sub

sub onPicked()
    q = m.items[m.list.itemSelected]
    if q = invalid or q.availableId = invalid then return
    if q.status <> "available" and not mqIsTrue(q.firstHere) then return
    kind = "movie"
    if q.kind = "show" then kind = "show"
    m.top.navigate = { screen: "DetailsScreen", params: { id: q.availableId, kind: kind } }
end sub

function onKeyEvent(key as String, press as Boolean) as Boolean
    if not press or key <> "options" then return false
    q = m.items[m.list.itemFocused]
    if q = invalid or (q.status <> "pending" and q.status <> "approved") then return true
    m.menuReq = q
    label = "Stop following"
    if q.status = "pending" and mqStr(q.requestedBy) = mqStr(m.global.username) then label = "Withdraw"
    m.menu.title = mqStr(q.title)
    m.menu.options = [label, "Keep it"]
    m.menu.current = -1
    m.menu.open = true
    return true
end function

sub onMenuChosen()
    m.list.setFocus(true)
    if m.menu.chosen = 0 then mqApi("/api/requests/" + m.menuReq.id, "onChanged", "DELETE")
end sub

sub onMenuClosed()
    m.list.setFocus(true)
end sub

sub onChanged()
    load()
end sub
