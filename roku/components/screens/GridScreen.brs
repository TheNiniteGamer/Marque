sub init()
    m.title = m.top.findNode("title")
    m.count = m.top.findNode("count")
    m.grid = m.top.findNode("grid")
    m.topBar = m.top.findNode("topBar")
    m.topBar.observeField("chosen", "onTopBar")
    m.topBar.observeField("leave", "onTopBarLeave")
    m.items = []
    m.top.observeField("focusedChild", "onFocusChange")
    m.grid.observeField("itemSelected", "onSelected")
end sub

sub onFocusChange()
    if m.top.hasFocus() then m.grid.setFocus(true)
end sub

sub onTopBarLeave()
    m.grid.setFocus(true)
end sub

sub onTopBar()
    c = m.topBar.chosen
    if c.key = "signedout" then
        m.top.navigate = { screen: "PairScreen", reset: true }
        return
    end if
    m.grid.setFocus(true)
    m.top.navigate = mqTopBarNav(c, false)
end sub

' Up from the top row reaches the top bar.
function onKeyEvent(key as String, press as Boolean) as Boolean
    if press and key = "up" and m.grid.hasFocus() then
        m.topBar.setFocus(true)
        return true
    end if
    return false
end function

sub onParams()
    m.topBar.current = mqStr(m.top.params.current)
    m.title.text = mqStr(m.top.params.title)
    m.count.text = "Loading…"
    load()
end sub

sub onRefresh()
    if m.top.refresh then load()
end sub

sub load()
    mqApi(m.top.params.path, "onLoaded")
end sub

sub onLoaded(event as Object)
    r = event.getData()
    if r.status <> 200 or r.data = invalid then
        m.count.text = "Can't load this: " + r.error
        return
    end if
    list = r.data
    if type(list) = "roAssociativeArray" then list = list.items
    if list = invalid then list = []
    keep = m.grid.itemFocused
    m.items = []
    root = CreateObject("roSGNode", "ContentNode")
    for each item in list
        if item.type <> "collection" then
            m.items.Push(item)
            root.appendChild(mqCard(item))
        end if
    end for
    m.grid.content = root
    if keep > 0 and keep < m.items.Count() then m.grid.jumpToItem = keep
    if m.items.Count() = 0 then m.count.text = "Nothing here yet." else m.count.text = m.items.Count().ToStr() + " titles"
end sub

sub onSelected()
    item = m.items[m.grid.itemSelected]
    if item = invalid then return
    if item.type = "episode" then
        m.top.navigate = { screen: "PlayerScreen", params: { id: item.id, start: -1 } }
    else
        m.top.navigate = { screen: "DetailsScreen", params: { id: item.id, kind: item.type } }
    end if
end sub
