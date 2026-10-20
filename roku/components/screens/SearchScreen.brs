sub init()
    m.keyboard = m.top.findNode("keyboard")
    m.status = m.top.findNode("status")
    m.results = m.top.findNode("results")
    m.typing = m.top.findNode("typing")
    m.ask = m.top.findNode("ask")
    m.ask.observeField("selected", "onAsk")
    m.items = []
    m.focus = m.keyboard
    m.top.observeField("focusedChild", "onFocusChange")
    m.keyboard.observeField("text", "onText")
    m.typing.observeField("fire", "search")
    m.results.observeField("itemSelected", "onSelected")
end sub

sub onFocusChange()
    if m.top.hasFocus() then m.focus.setFocus(true)
end sub

sub onText()
    m.typing.control = "stop"
    m.typing.control = "start"
end sub

sub search()
    q = m.keyboard.text.Trim()
    m.ask.visible = q <> ""
    if q <> "" then m.ask.buttons = ["Not here? Ask for “" + q + "”"]
    if q = "" then
        m.results.content = invalid
        m.items = []
        m.status.text = "Type a title or an episode name."
        return
    end if
    mqApi("/api/search?q=" + mqEscape(q), "onResults")
end sub

sub onResults(event as Object)
    r = event.getData()
    if r.status <> 200 or r.data = invalid then
        m.status.text = "Search failed: " + r.error
        return
    end if
    m.items = []
    root = CreateObject("roSGNode", "ContentNode")
    for each group in ["shows", "movies", "episodes"]
        list = r.data[group]
        if list <> invalid then
            for each item in list
                m.items.Push(item)
                root.appendChild(mqCard(item))
            end for
        end if
    end for
    m.results.content = root
    if m.items.Count() = 0 then m.status.text = "Nothing found." else m.status.text = ""
end sub

sub onSelected()
    item = m.items[m.results.itemSelected]
    if item = invalid then return
    m.top.navigate = { screen: "DetailsScreen", params: { id: item.id, kind: item.type } }
end sub

sub onAsk()
    m.top.navigate = { screen: "AskScreen", params: { q: m.keyboard.text.Trim() } }
end sub

function onKeyEvent(key as String, press as Boolean) as Boolean
    if not press then return false
    if key = "right" and m.keyboard.isInFocusChain() then
        if m.items.Count() > 0 then
            m.focus = m.results
        else if m.ask.visible then
            m.focus = m.ask
        else
            return false
        end if
        m.focus.setFocus(true)
        return true
    end if
    if key = "left" and (m.results.hasFocus() or m.ask.hasFocus()) then
        m.focus = m.keyboard
        m.keyboard.setFocus(true)
        return true
    end if
    if key = "up" and m.results.hasFocus() and m.ask.visible then
        m.focus = m.ask
        m.ask.setFocus(true)
        return true
    end if
    if key = "down" and m.ask.hasFocus() and m.items.Count() > 0 then
        m.focus = m.results
        m.results.setFocus(true)
        return true
    end if
    return false
end function
