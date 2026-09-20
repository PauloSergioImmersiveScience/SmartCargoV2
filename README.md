# SmartScanCargo

Interface web para leitura sequencial de imagens de raio X e HEMD, criação de bounding boxes na imagem de raio X, reprodução proporcional automática das caixas na imagem HEMD, equalização de histograma no raio X e gravação dos relatórios diretamente na pasta selecionada.

As coordenadas das bounding boxes não são exibidas no campo de edição do relatório. Elas são acrescentadas somente ao arquivo `Relatorio<índice>.txt` no momento da gravação. Após salvar, a interface mostra uma caixa de aviso nativa do navegador com o local do arquivo gerado. Os arquivos CSS e JavaScript usam identificação de versão para impedir que o navegador mantenha a implementação anterior em cache.

Para cada caixa criada, o campo visível recebe uma linha de comentário no formato `BB1: comente ...`, `BB2: comente ...` e assim sucessivamente. Somente o relatório salvo contém a seção `Coordenadas dos BBs`, associando cada índice às suas coordenadas numéricas.

## Senha de acesso

A aplicação abre inicialmente uma tela de acesso. A senha padrão é `123456`. Para alterá-la, edite o arquivo `dist/index.html` e procure pelo comentário `PARA ALTERAR A SENHA`. Modifique somente o valor da constante:

```javascript
const ACCESS_PASSWORD = "0112358";
```

Esta verificação ocorre no navegador e serve apenas como uma barreira simples de acesso; ela não substitui autenticação segura realizada por um servidor.

A versão 7 executa o login de forma independente do código principal, fecha explicitamente a tela de acesso após a senha correta e oferece um botão com ícone de olho para exibir ou ocultar a senha digitada.

## Navegadores compatíveis

Use uma versão atual do Google Chrome ou Microsoft Edge. A aplicação utiliza a File System Access API para ler e gravar na pasta escolhida pelo usuário.

## Estrutura esperada da pasta local

```text
cargas/
├── Imagem1/
│   ├── xray1.png
│   ├── hemd1.png
│   └── InfoSuspeitas1.txt
├── Imagem2/
│   ├── xray2.png
│   ├── hemd2.png
│   └── InfoSuspeitas2.txt
└── ...
```

O arquivo `InfoSuspeitas<índice>.txt` pode utilizar `:` ou `=` para separar chaves e valores. São lidos os campos `suspeito`, `mercadoria_nf`, `des_conteudo` e `mercadoria_manifestada`.

## Execução local

Por segurança do navegador, execute o projeto por um servidor local. No diretório do projeto:

```bash
python -m http.server 8000 --directory dist
```

Depois, acesse `http://localhost:8000` no Chrome ou Edge.

## Publicação no GitHub Pages

O projeto inclui um workflow de publicação. Crie um repositório, envie todos os arquivos e, nas configurações do GitHub Pages, selecione **GitHub Actions** como origem.

## Relatórios

O botão **UpLoad Images** solicita a seleção da pasta principal local e carrega a primeira imagem. Ao clicar em **Gerar Relatório**, a aplicação cria a pasta `Relatorios` dentro da pasta principal selecionada. Somente o arquivo `Relatorio<índice>.txt` correspondente à carga atual é criado ou substituído; os demais relatórios são preservados.
