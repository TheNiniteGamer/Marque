sub init()
    m.rows = m.top.findNode("rows")
    m.status = m.top.findNode("status")
    m.topBar = m.top.findNode("topBar")
    m.topBar.observeField("chosen", "onTopBar")
    m.topBar.observeField("leave", "onTopBarLeave")
    m.rows.observeField("rowItemSelected", "onSelected")
    m.top.observeField("focusedChild", "onFocusChange")
    m.lists = []
    m.status.text = "Loading…"
end sub

sub onFocusChange()
    if m.top.hasFocus() then m.rows.setFocus(true)
end sub

sub onParams()
    load()
end sub

sub onRefresh()
    if m.top.refresh then load()
end sub

sub load()
    mqApi("/api/collections", "onLoaded")
end sub

sub onLoaded(event as Object)
    r = event.getData()
    if r.status <> 200 or r.data = invalid then
        m.status.text = "Can't load the collections: " + r.error
        return
    end if
    heads = { franchises: "Franchises", movies: "Movie collections", shows: "TV collections", videos: "YouTube collections" }
    root = CreateObject("roSGNode", "ContentNode")
    m.lists = []
    for each key in ["franchises", "movies", "shows", "videos"]
        list = []
        for each c in r.data
            if mqStr(c.section) = key and not mqIsTrue(c.hidden) then list.Push(c)
        end for
        if list.Count() > 0 then
            row = root.createChild("ContentNode")
            row.title = heads[key]
            for each c in list
                row.appendChild(mqCollectionCard(c))
            end for
            m.lists.Push(list)
        end if
    end for
    keep = m.rows.rowItemFocused
    m.rows.content = root
    if keep <> invalid and keep.Count() = 2 and keep[0] < root.getChildCount() then m.rows.jumpToRowItem = keep
    if root.getChildCount() = 0 then m.status.text = "No collections yet." else m.status.text = ""
end sub

sub onSelected()
    at = m.rows.rowItemSelected
    if at = invalid or at[0] >= m.lists.Count() then return
    c = m.lists[at[0]][at[1]]
    if c = invalid then return
    c.type = "collection"
    m.top.navigate = mqOpen(c)
end sub

sub onTopBarLeave()
    m.rows.setFocus(true)
end sub

sub onTopBar()
    c = m.topBar.chosen
    if c.key = "signedout" then
        m.top.navigate = { screen: "PairScreen", reset: true }
        return
    end if
    m.rows.setFocus(true)
    m.top.navigate = mqTopBarNav(c, false)
end sub

function onKeyEvent(key as String, press as Boolean) as Boolean
    if press and key = "up" and m.rows.hasFocus() then
        m.topBar.setFocus(true)
        return true
    end if
    return false
end function
