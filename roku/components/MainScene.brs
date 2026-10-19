sub init()
    m.top.backgroundColor = "0x0B0B0BFF"
    m.top.backgroundUri = ""
    m.global.addFields({ server: mqRead("server"), token: mqRead("token"), username: mqRead("username") })
    m.stack = []
    m.screens = m.top.findNode("screens")
    if m.global.server = "" then
        show("SetupScreen", {}, false, true)
    else if m.global.token = "" then
        show("PairScreen", {}, false, true)
    else
        show("HomeScreen", {}, false, true)
    end if
end sub

sub show(name as String, params as Object, replace as Boolean, reset as Boolean)
    if reset then
        while m.stack.Count() > 0
            m.screens.removeChild(m.stack.Pop())
        end while
    else if replace and m.stack.Count() > 0 then
        m.screens.removeChild(m.stack.Pop())
    end if
    if m.stack.Count() > 0 then m.stack.Peek().visible = false
    screen = CreateObject("roSGNode", name)
    screen.observeField("navigate", "onNavigate")
    m.stack.Push(screen)
    m.screens.appendChild(screen)
    screen.params = params
    screen.setFocus(true)
end sub

' A screen's request: { screen, params, replace, reset } to open one, or { back: true }.
sub onNavigate(event as Object)
    nav = event.getData()
    if nav = invalid then return
    if mqIsTrue(nav.back) then
        goBack()
        return
    end if
    params = nav.params
    if params = invalid then params = {}
    show(nav.screen, params, mqIsTrue(nav.replace), mqIsTrue(nav.reset))
end sub

function goBack() as Boolean
    if m.stack.Count() <= 1 then return false
    m.screens.removeChild(m.stack.Pop())
    top = m.stack.Peek()
    top.visible = true
    top.refresh = true
    top.setFocus(true)
    return true
end function

function onKeyEvent(key as String, press as Boolean) as Boolean
    if press and key = "back" then return goBack()
    return false
end function
